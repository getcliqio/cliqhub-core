/**
 * Regression tests for `RunService.load_pending_control`.
 *
 * This is the backend half of the "clicked Cancel — nothing happened"
 * fix. When the UI POSTs `/v1/runs/cancel`, all Hub does is
 * enqueue a row into `cliq.command_outbox` — the daemon is what
 * actually terminates the run. Before this method existed, the run
 * detail page had no way to see the enqueued row, so the operator
 * saw the Cancel button stay hot and the state stay `running` with
 * no indication of *why*.
 *
 * The method reads the newest un-acked control command whose payload
 * targets a given `run_id`. These tests pin the SQL shape (endpoints
 * filter, acked_at gate, attempts gate) and the mapping from raw
 * row → typed `PendingControl` — the two places this contract can
 * silently drift.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    query: vi.fn(),
    run_find_by_pk: vi.fn(),
}));

vi.mock('../../../src/lib/sequelize.js', () => ({
    get_sequelize: () => ({ query: mocks.query }),
}));

vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({
        info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
    }),
}));

vi.mock('../../../src/models/index.js', () => ({
    Run: { findByPk: mocks.run_find_by_pk },
    RunEvent: {},
    RunLog: {},
    RunLogLine: {},
    RunPhase: {},
    RunArtifact: {},
    Team: {},
    Scope: {},
    Workspace: {},
    RealmMember: {},
    Daemon: {},
    Realm: {},
}));

vi.mock('../../../src/services/realm.service.js', () => ({
    RealmService: {},
}));

import { RunService } from '../../../src/services/run.service.js';

describe('RunService.load_pending_control', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns null immediately when the run has no daemon assignment (no daemon = no outbox)', async () => {
        // Guard: the outbox is keyed on daemon_id. If a run never
        // got dispatched to a daemon, there's definitionally no
        // control command to look up, and we must short-circuit
        // before hitting Postgres (the query would be a full
        // scan for a match that can't exist).
        const result = await RunService.load_pending_control(null, 'run-xyz');
        expect(result).toBeNull();
        expect(mocks.query).not.toHaveBeenCalled();
    });

    it('filters on the exact control endpoints, matches by payload run_id, and only returns un-acked rows still under the attempt cap', async () => {
        mocks.query.mockResolvedValueOnce([]);

        await RunService.load_pending_control('dmn-1', 'run-abc');

        expect(mocks.query).toHaveBeenCalledTimes(1);
        const [sql, opts] = mocks.query.mock.calls[0];

        // Endpoint list is the run-scoped control set — commands the
        // user needs to know are "in flight" between Hub and daemon.
        // /v1/resume and /v1/execute joined this list so the "queued —
        // waiting for daemon" banner fires for Resume / Start too;
        // without them, hitting Resume and watching an unchanged run
        // for 30s looked like a bug.
        expect((opts as { replacements: { endpoints: string[] } }).replacements.endpoints)
            .toEqual(['/v1/cancel', '/v1/runs/supply_inputs', '/v1/resume', '/v1/execute']);

        // Filter on daemon + run_id inside JSONB payload.
        expect(sql).toMatch(/"daemon_id"\s*=\s*:daemon_id/);
        expect(sql).toMatch(/"payload"->>'run_id'\s*=\s*:run_id/);

        // Terminal states must NOT show up in the banner:
        //   • acked_at IS NULL         → daemon hasn't confirmed yet
        //   • attempts < max_attempts  → not permanently failed
        // Regression: without either gate, a fully-delivered cancel
        // would keep the button disabled forever, and a dead command
        // would nag the user with a banner they can't clear.
        expect(sql).toMatch(/"acked_at"\s*IS\s*NULL/);
        expect(sql).toMatch(/"attempts"\s*<\s*"max_attempts"/);

        // Newest first — if a supply_inputs and a later cancel both
        // exist, the cancel wins.
        expect(sql).toMatch(/ORDER BY\s+"created_at"\s+DESC/i);
        expect(sql).toMatch(/LIMIT\s+1/);
    });

    it('maps the raw command_outbox row into the typed PendingControl shape the UI expects', async () => {
        mocks.query.mockResolvedValueOnce([
            {
                tx_id: 'tx-1',
                endpoint: '/v1/cancel',
                created_at: '1700000000000',
                attempts: 2,
                max_attempts: 5,
                delivered_at: null,       // still queued
                error: 'connection reset',
                ack_status: null,
            },
        ]);

        const result = await RunService.load_pending_control('dmn-1', 'run-abc');

        expect(result).toEqual({
            tx_id: 'tx-1',
            endpoint: '/v1/cancel',
            enqueued_at: 1700000000000, // BIGINT string → number
            attempts: 2,
            max_attempts: 5,
            delivered_at: null,
            last_error: 'connection reset',
            ack_status: null,
        });
    });

    it('normalises the BIGINT `delivered_at` string when the Hub worker has already POSTed to the daemon', async () => {
        mocks.query.mockResolvedValueOnce([
            {
                tx_id: 'tx-2',
                endpoint: '/v1/cancel',
                created_at: '1700000000000',
                attempts: 3,
                max_attempts: 5,
                delivered_at: '1700000005000', // POSTed 5s later
                error: null,
                ack_status: null,
            },
        ]);

        const result = await RunService.load_pending_control('dmn-1', 'run-abc');

        expect(result?.delivered_at).toBe(1700000005000);
        expect(result?.last_error).toBeNull();
    });

    it('returns null when no matching pending command exists (empty query result)', async () => {
        // Happy path — nothing to render, nothing to disable. The
        // Cancel button should be interactive again.
        mocks.query.mockResolvedValueOnce([]);
        const result = await RunService.load_pending_control('dmn-1', 'run-abc');
        expect(result).toBeNull();
    });
});
