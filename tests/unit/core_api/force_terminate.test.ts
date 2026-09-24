/**
 * Cancel escalates to Hub-side terminate when the daemon is unreachable
 * (or a prior cancel has gone stale). Pins the hub mark SQL + outbox purge.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    run_find_by_pk: vi.fn(),
    daemon_find_by_pk: vi.fn(),
    assert_can_observe_daemon: vi.fn(),
    command_outbox_enqueue: vi.fn(),
    log_info: vi.fn(),
    log_warn: vi.fn(),
    log_debug: vi.fn(),
    log_error: vi.fn(),
    expire_pending: vi.fn(async () => undefined),
}));

vi.mock('../../../src/lib/sequelize.js', () => ({
    get_sequelize: () => ({ query: mocks.query }),
}));

vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({
        info: mocks.log_info,
        warn: mocks.log_warn,
        debug: mocks.log_debug,
        error: mocks.log_error,
    }),
}));

vi.mock('../../../src/models/index.js', () => ({
    Run: { findByPk: mocks.run_find_by_pk },
    Daemon: { findByPk: mocks.daemon_find_by_pk },
    Workspace: {},
    Team: {},
    Scope: {},
    RealmMember: {},
    RealmAgentSetting: {},
    Realm: {},
}));

vi.mock('../../../src/services/access.service.js', () => ({
    AccessService: {
        assert_can_observe_daemon: mocks.assert_can_observe_daemon,
    },
}));

vi.mock('../../../src/services/command_outbox.service.js', () => ({
    command_outbox_enqueue: mocks.command_outbox_enqueue,
}));

vi.mock('../../../src/services/hug_reviews.service.js', () => ({
    HugReviewsService: {
        expire_pending_for_run: mocks.expire_pending,
    },
}));

vi.mock('../../../src/services/run.service.js', () => ({ RunService: {} }));
vi.mock('../../../src/services/teams_install_service.js', () => ({ TeamService: {} }));
vi.mock('../../../src/services/realm.service.js', () => ({ RealmService: {} }));
vi.mock('../../../src/services/queue.service.js', () => ({ QueueService: {} }));
vi.mock('../../../src/services/dispatch_auth.service.js', () => ({ DispatchAuthService: {} }));
vi.mock('../../../src/services/custom_event.service.js', () => ({ CustomEventService: {} }));
vi.mock('../../../src/lib/api_error.js', () => ({
    ApiError: {
        forbidden: (msg: string) => Object.assign(new Error(msg), { status: 403, status_code: 403 }),
        not_found: (msg: string) => Object.assign(new Error(msg), { status: 404, status_code: 404 }),
        bad_request: (msg: string) => Object.assign(new Error(msg), { status: 400, status_code: 400 }),
        conflict: (msg: string, code?: string) => Object.assign(new Error(msg), { status: 409, status_code: 409, code }),
    },
}));
vi.mock('../../../src/db/models/index.js', () => ({ Team: {}, TeamVersion: {} }));
vi.mock('../../../src/lib/semver.js', () => ({ sort_semver_desc: () => [] }));

import { DispatchService } from '../../../src/services/dispatch.service.js';

const USER = 'user-1';
const RUN = 'run-abc';
const DAEMON = 'dmn-krupali';

function _live_run(overrides: Record<string, unknown> = {}) {
    return {
        run_id: RUN,
        daemon_id: DAEMON,
        state: 'running',
        lease_expires_at: null,
        ...overrides,
    };
}

describe('DispatchService.cancel_run — hub escalate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.assert_can_observe_daemon.mockResolvedValue(undefined);
        // Default eligibility query: no stale cancel
        mocks.query.mockResolvedValue([{ oldest_created_at: null }]);
    });

    it('rejects unauthenticated requests', async () => {
        await expect(DispatchService.cancel_run(RUN, [], undefined))
            .rejects.toThrow(/authenticated/i);
        expect(mocks.query).not.toHaveBeenCalled();
    });

    it('rejects when the run is not found', async () => {
        mocks.run_find_by_pk.mockResolvedValueOnce(null);
        await expect(DispatchService.cancel_run(RUN, [], USER))
            .rejects.toThrow(/not found/i);
    });

    it('is a no-op on already-terminal runs', async () => {
        mocks.run_find_by_pk.mockResolvedValueOnce(_live_run({ state: 'completed' }));
        const result = await DispatchService.cancel_run(RUN, [], USER);
        expect(result).toEqual({ cancelled: true, mode: 'already_terminal' });
        expect(mocks.command_outbox_enqueue).not.toHaveBeenCalled();
    });

    it('queues cancel when daemon is heartbeating and no escalate trigger', async () => {
        mocks.run_find_by_pk.mockResolvedValueOnce(_live_run());
        mocks.daemon_find_by_pk.mockResolvedValue({
            id: DAEMON,
            last_heartbeat: Date.now(),
            name: 'ok',
        });
        const result = await DispatchService.cancel_run(RUN, [], USER);
        expect(result).toEqual({ cancelled: true, mode: 'queued' });
        expect(mocks.command_outbox_enqueue).toHaveBeenCalledWith(
            DAEMON,
            '/v1/cancel',
            expect.objectContaining({ run_id: RUN }),
        );
    });

    it('hub-terminates when daemon is offline', async () => {
        mocks.run_find_by_pk.mockResolvedValueOnce(_live_run());
        mocks.daemon_find_by_pk.mockResolvedValue({
            id: DAEMON,
            last_heartbeat: Date.now() - 5 * 60_000,
            name: 'dead',
        });
        const result = await DispatchService.cancel_run(RUN, [], USER, 'operator gave up');
        expect(result).toEqual({ cancelled: true, mode: 'hub_terminated' });
        expect(mocks.command_outbox_enqueue).not.toHaveBeenCalled();
        const state_sql = String(mocks.query.mock.calls.find((c) =>
            String(c[0]).includes('force_terminated_at'),
        )?.[0] ?? '');
        expect(state_sql).toMatch(/"force_terminated_at" = :now/);
    });

    it('hub-terminates when a cancel has been stale ≥ 5 min', async () => {
        mocks.run_find_by_pk.mockResolvedValueOnce(_live_run());
        mocks.daemon_find_by_pk.mockResolvedValue({
            id: DAEMON,
            last_heartbeat: Date.now(),
            name: 'ok',
        });
        // First query in eligibility: stale cancel age
        mocks.query.mockResolvedValueOnce([{
            oldest_created_at: String(Date.now() - 6 * 60_000),
        }]);
        const result = await DispatchService.cancel_run(RUN, [], USER);
        expect(result).toEqual({ cancelled: true, mode: 'hub_terminated' });
        expect(mocks.command_outbox_enqueue).not.toHaveBeenCalled();
    });
});
