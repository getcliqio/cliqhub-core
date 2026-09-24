/**
 * Unit tests for DispatchService — verifies AuthZ gating, daemon
 * resolution, and the _post_to_daemon transport layer through
 * the public dispatch_run / cancel_run / install_team methods.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

// ── Mocks — must appear before importing the module under test ──────

vi.mock('../../src/models/index.js', () => ({
    Workspace: { findByPk: vi.fn(), findOne: vi.fn(), create: vi.fn() },
    Run: { findByPk: vi.fn() },
    Team: {
        findByPk: vi.fn(),
        findOne: vi.fn(),
        findAll: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
    },
    Daemon: { findByPk: vi.fn(), findAll: vi.fn() },
    Scope: { findByPk: vi.fn(), findOne: vi.fn() },
}));

vi.mock('../../src/db/models/index.js', () => ({
    Team: { findByPk: vi.fn(), findOne: vi.fn() },
    TeamVersion: { findOne: vi.fn(), findAll: vi.fn() },
}));

vi.mock('../../src/services/run.service.js', () => ({
    RunService: { create: vi.fn(async () => 'run-001') },
}));

vi.mock('../../src/services/access.service.js', () => ({
    AccessService: {
        assert_scope_access: vi.fn(),
        assert_can_run_team_on_daemon: vi.fn(async () => undefined),
        assert_can_observe_daemon: vi.fn(async () => undefined),
        list_daemon_ids_for_user: vi.fn(async () => ['daemon-1']),
        assert_realm_access: vi.fn(async () => undefined),
    },
}));

vi.mock('../../src/services/realm.service.js', () => ({
    RealmService: {
        list_online_daemon_ids_in_realm: vi.fn(async () => []),
        list_daemon_ids_for_user: vi.fn(async () => ['daemon-1']),
        list_realms_for_daemon: vi.fn(async () => []),
        assert_member: vi.fn(async () => undefined),
    },
}));

vi.mock('../../src/services/dispatch_auth.service.js', () => ({
    DispatchAuthService: {
        authorization_header: vi.fn(async () => 'Bearer test-dispatch-token'),
        mint_token: vi.fn(async () => ({
            token: 'test-dispatch-token',
            expires_in: 300,
            realm_id: 'realm-1',
        })),
    },
}));

vi.mock('../../src/services/queue.service.js', () => ({
    QueueService: {
        get: vi.fn(),
        mark_offered: vi.fn(async (id: string) => ({ id, status: 'offered' })),
        set_results: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
            id,
            ...patch,
        })),
        create: vi.fn(),
    },
}));

vi.mock('../../src/lib/log.js', () => ({
    get_logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Mock command outbox — dispatch now uses durable enqueue instead of direct fetch.
vi.mock('../../src/services/command_outbox.service.js', () => ({
    command_outbox_enqueue: vi.fn(async () => 'mock-tx-id'),
}));

vi.mock('../../src/lib/sequelize.js', () => ({
    get_sequelize: () => ({
        query: vi.fn(async () => [{ oldest_created_at: null }]),
    }),
}));

vi.mock('../../src/services/hug_reviews.service.js', () => ({
    HugReviewsService: {
        expire_pending_for_run: vi.fn(async () => undefined),
    },
}));

import { Workspace, Run, Team, Daemon, Scope } from '../../src/models/index.js';
import { Team as HubTeam, TeamVersion } from '../../src/db/models/index.js';
import { DispatchService } from '../../src/services/dispatch.service.js';
import { AccessService } from '../../src/services/access.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { QueueService } from '../../src/services/queue.service.js';
import { RunService } from '../../src/services/run.service.js';
import { command_outbox_enqueue } from '../../src/services/command_outbox.service.js';

const mock_enqueue = vi.mocked(command_outbox_enqueue);

// ── Helpers ─────────────────────────────────────────────────────────

/** Builds a fake Daemon row. */
function make_daemon(overrides: Record<string, unknown> = {}) {
    return {
        id: 'daemon-1',
        public_url: 'https://daemon.test:8443',
        status: 'online',
        last_heartbeat: Date.now(),
        ...overrides,
    };
}

/** Builds a fake Workspace row. */
function make_workspace(overrides: Record<string, unknown> = {}) {
    return {
        id: 'ws-1',
        path: '/home/user/project',
        daemon_id: 'daemon-1',
        ...overrides,
    };
}

/** Builds a fake Team row. */
function make_team(overrides: Record<string, unknown> = {}) {
    return {
        id: 'team-1',
        scope_id: 'scope-1',
        slug: 'my-team',
        manifest: 'name: my-team\nversion: "1.0.0"\nphases: []\n',
        version: '1.0.0',
        description: 'test team',
        dependencies: null,
        ...overrides,
    };
}

/** Minimal dispatch_run input. */
function make_dispatch_input(overrides: Record<string, unknown> = {}) {
    return {
        workspace_id: 'ws-1',
        team_id: 'team-1',
        daemon_id: 'daemon-1',
        user_id: 'user-1',
        scope_ids: ['scope-1'],
        run_context: {
            inputs: {},
            id: undefined,
            labels: undefined,
        },
        ...overrides,
    };
}

/** Creates a mock fetch Response. */
function ok_response(body: unknown = {}): Response {
    return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

function error_response(status = 500, body = 'error'): Response {
    return {
        ok: false,
        status,
        json: async () => ({ error: body }),
        text: async () => body,
    } as unknown as Response;
}

// ── Setup ───────────────────────────────────────────────────────────

let mock_fetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
    mock_fetch = vi.fn();
    vi.stubGlobal('fetch', mock_fetch);

    // Default mock returns — overridden per test as needed
    vi.mocked(Workspace.findByPk).mockResolvedValue(make_workspace() as any);
    vi.mocked(Team.findByPk).mockResolvedValue(make_team() as any);
    vi.mocked(HubTeam.findByPk).mockResolvedValue({
        id: hub_legacy_uuid(1),
        name: 'my-team',
        scope: 'my-scope',
        description: 'test team',
    } as any);
    vi.mocked(HubTeam.findOne).mockResolvedValue(null as any);
    vi.mocked(TeamVersion.findOne).mockResolvedValue({
        team_id: hub_legacy_uuid(1),
        version: '1.0.0',
        workflow_json: 'name: my-team\nversion: "1.0.0"\nphases: []\n',
    } as any);
    // Semver-aware latest lookup now uses findAll — return same fixture
    // so the "highest version" pick lands on this row.
    vi.mocked(TeamVersion.findAll).mockResolvedValue([{
        team_id: hub_legacy_uuid(1),
        version: '1.0.0',
        workflow_json: 'name: my-team\nversion: "1.0.0"\nphases: []\n',
    }] as any);
    vi.mocked(Daemon.findByPk).mockResolvedValue(make_daemon() as any);
    vi.mocked(Daemon.findAll).mockResolvedValue([make_daemon()] as any);
    vi.mocked(Scope.findOne).mockResolvedValue({ id: 'scope-1', slug: 'my-scope' } as any);
    vi.mocked(Scope.findByPk).mockResolvedValue({ id: 'scope-1', slug: 'my-scope' } as any);
    vi.mocked(Team.findOne).mockResolvedValue(null as any);
    vi.mocked(Team.create).mockResolvedValue(make_team() as any);
    vi.mocked(AccessService.list_daemon_ids_for_user).mockResolvedValue(['daemon-1']);
    vi.mocked(RealmService.list_realms_for_daemon).mockResolvedValue([]);
});

// ── dispatch_run ────────────────────────────────────────────────────

describe('DispatchService.dispatch_run', () => {

    it('enqueues execute command via outbox on happy path', async () => {
        const result = await DispatchService.dispatch_run(make_dispatch_input());

        expect(result.run_id).toBe('run-001');
        expect(result.daemon_id).toBe('daemon-1');

        expect(mock_enqueue).toHaveBeenCalledWith(
            'daemon-1',
            '/v1/execute',
            expect.objectContaining({
                run_id: 'run-001',
                workspace_dir: '/home/user/project',
            }),
        );
    });

    it('throws forbidden when user_id is missing', async () => {
        await expect(
            DispatchService.dispatch_run(make_dispatch_input({ user_id: '' })),
        ).rejects.toThrow(/Not authenticated/);
    });

    it('allows missing workspace when workspace_path is provided', async () => {
        vi.mocked(Workspace.findByPk).mockResolvedValueOnce(null as any);

        const result = await DispatchService.dispatch_run(
            make_dispatch_input({ workspace_path: '/tmp/project' }),
        );
        expect(result.run_id).toBe('run-001');
        expect(result.daemon_id).toBe('daemon-1');
        expect(mock_enqueue).toHaveBeenCalled();
    });

    it('allows missing team when manifest_yaml is provided', async () => {
        vi.mocked(Team.findByPk).mockResolvedValueOnce(null as any);

        const result = await DispatchService.dispatch_run(
            make_dispatch_input({ manifest_yaml: 'name: x\nphases: []\n' }),
        );
        expect(result.run_id).toBe('run-001');
        expect(result.daemon_id).toBe('daemon-1');
        expect(mock_enqueue).toHaveBeenCalled();
    });

    it('throws not_found when no daemon is available', async () => {
        vi.mocked(Daemon.findByPk).mockResolvedValue(null as any);
        vi.mocked(Daemon.findAll).mockResolvedValue([] as any);
        vi.mocked(AccessService.list_daemon_ids_for_user).mockResolvedValue([]);

        await expect(
            DispatchService.dispatch_run(make_dispatch_input()),
        ).rejects.toThrow(/Daemon .* not found/i);
    });

    // Note: Tests for public_url validation, offline daemon rejection,
    // and transport errors were removed — dispatch now enqueues to the
    // command outbox. Delivery and retry are tested in command_outbox.test.ts.

    it('sends workspace_dir and manifest_yaml in outbox payload', async () => {
        await DispatchService.dispatch_run(make_dispatch_input());

        const payload = mock_enqueue.mock.calls[0][2] as Record<string, unknown>;
        expect(payload.workspace_dir).toBe('/home/user/project');
        expect(payload.manifest_yaml).toBeDefined();
        expect(payload.run_id).toBe('run-001');
    });

    it('uses team manifest when manifest_yaml not provided', async () => {
        await DispatchService.dispatch_run(make_dispatch_input());

        const payload = mock_enqueue.mock.calls[0][2] as Record<string, unknown>;
        expect(payload.manifest_yaml).toBe('name: my-team\nversion: "1.0.0"\nphases: []\n');
    });

    it('uses provided manifest_yaml over team manifest', async () => {
        await DispatchService.dispatch_run(
            make_dispatch_input({ manifest_yaml: 'custom: true' }),
        );

        const payload = mock_enqueue.mock.calls[0][2] as Record<string, unknown>;
        expect(payload.manifest_yaml).toBe('custom: true');
    });
});

// ── cancel_run ──────────────────────────────────────────────────────

describe('DispatchService.cancel_run', () => {

    it('enqueues cancel to outbox on success', async () => {
        vi.mocked(Run.findByPk).mockResolvedValueOnce({
            id: 'run-cancel',
            run_id: 'run-cancel',
            daemon_id: 'daemon-1',
            state: 'running',
            lease_expires_at: null,
        } as any);

        const result = await DispatchService.cancel_run('run-cancel', [], 'user-1');

        expect(result).toEqual({ cancelled: true, mode: 'queued' });
        expect(mock_enqueue).toHaveBeenCalledWith(
            'daemon-1',
            '/v1/cancel',
            expect.objectContaining({ run_id: 'run-cancel' }),
        );
    });

    it('throws forbidden when user_id is missing', async () => {
        await expect(
            DispatchService.cancel_run('run-1', []),
        ).rejects.toThrow(/Not authenticated/);
    });

    it('throws not_found when run does not exist', async () => {
        vi.mocked(Run.findByPk).mockResolvedValueOnce(null as any);

        await expect(
            DispatchService.cancel_run('run-missing', [], 'user-1'),
        ).rejects.toThrow(/not found/i);
    });

    it('hub-terminates when run has no daemon_id', async () => {
        vi.mocked(Run.findByPk).mockResolvedValueOnce({
            id: 'run-no-daemon',
            run_id: 'run-no-daemon',
            daemon_id: null,
            state: 'running',
            lease_expires_at: null,
        } as any);

        const result = await DispatchService.cancel_run('run-no-daemon', [], 'user-1');
        expect(result).toEqual({ cancelled: true, mode: 'hub_terminated' });
        expect(mock_enqueue).not.toHaveBeenCalled();
    });

    it('hub-terminates when daemon row is missing', async () => {
        vi.mocked(Run.findByPk).mockResolvedValueOnce({
            id: 'run-orphan',
            run_id: 'run-orphan',
            daemon_id: 'daemon-gone',
            state: 'running',
            lease_expires_at: null,
        } as any);
        vi.mocked(Daemon.findByPk).mockResolvedValueOnce(null as any);

        const result = await DispatchService.cancel_run('run-orphan', [], 'user-1');
        expect(result).toEqual({ cancelled: true, mode: 'hub_terminated' });
        expect(mock_enqueue).not.toHaveBeenCalled();
    });
});

// ── resume ──────────────────────────────────────────────────────────

describe('DispatchService.resume', () => {

    it('enqueues resume to outbox with from_phase on success', async () => {
        vi.mocked(Run.findByPk).mockResolvedValueOnce({
            id: 'run-resume',
            daemon_id: 'daemon-1',
        } as any);

        const result = await DispatchService.resume(
            'run-resume',
            'phase-2',
            [],
            'user-1',
        );

        expect(result).toEqual({ resumed: true, from_phase: 'phase-2' });
        expect(mock_enqueue).toHaveBeenCalledWith(
            'daemon-1',
            '/v1/resume',
            expect.objectContaining({ run_id: 'run-resume', from_phase: 'phase-2' }),
        );
    });

    it('throws forbidden when user_id is missing', async () => {
        await expect(
            DispatchService.resume('run-1', 'phase-1', []),
        ).rejects.toThrow(/Not authenticated/);
    });

    it('throws not_found when run does not exist', async () => {
        vi.mocked(Run.findByPk).mockResolvedValueOnce(null as any);

        await expect(
            DispatchService.resume('run-missing', 'phase-1', [], 'user-1'),
        ).rejects.toThrow(/not found/i);
    });

    it('throws 409 run/stranded when run has no daemon_id', async () => {
        vi.mocked(Run.findByPk).mockResolvedValueOnce({
            id: 'run-no-daemon',
            run_id: 'run-no-daemon',
            daemon_id: null,
        } as any);

        await expect(
            DispatchService.resume('run-no-daemon', 'phase-1', [], 'user-1'),
        ).rejects.toMatchObject({ status_code: 409, code: 'run/stranded' });
    });

    it('throws 409 run/daemon_stranded when daemon row is missing', async () => {
        vi.mocked(Run.findByPk).mockResolvedValueOnce({
            id: 'run-orphan',
            run_id: 'run-orphan',
            daemon_id: 'daemon-gone',
        } as any);
        vi.mocked(Daemon.findByPk).mockResolvedValueOnce(null as any);

        await expect(
            DispatchService.resume('run-orphan', 'phase-1', [], 'user-1'),
        ).rejects.toMatchObject({ status_code: 409, code: 'run/daemon_stranded' });
    });

    it('throws 409 run/daemon_offline when heartbeat is stale (5 min old)', async () => {
        vi.mocked(Run.findByPk).mockResolvedValueOnce({
            id: 'run-offline',
            run_id: 'run-offline',
            daemon_id: 'daemon-offline',
        } as any);
        vi.mocked(Daemon.findByPk).mockResolvedValueOnce(make_daemon({
            id: 'daemon-offline',
            name: 'sleepy-daemon',
            last_heartbeat: Date.now() - (5 * 60_000),
        }) as any);

        await expect(
            DispatchService.resume('run-offline', 'phase-1', [], 'user-1'),
        ).rejects.toMatchObject({ status_code: 409, code: 'run/daemon_offline' });
        expect(mock_enqueue).not.toHaveBeenCalled();
    });

    it('throws 409 run/daemon_stranded when heartbeat is >24h old', async () => {
        vi.mocked(Run.findByPk).mockResolvedValueOnce({
            id: 'run-abandoned',
            run_id: 'run-abandoned',
            daemon_id: 'daemon-gone',
        } as any);
        vi.mocked(Daemon.findByPk).mockResolvedValueOnce(make_daemon({
            id: 'daemon-gone',
            name: 'ghost-daemon',
            last_heartbeat: Date.now() - (25 * 60 * 60_000),
        }) as any);

        await expect(
            DispatchService.resume('run-abandoned', 'phase-1', [], 'user-1'),
        ).rejects.toMatchObject({ status_code: 409, code: 'run/daemon_stranded' });
        expect(mock_enqueue).not.toHaveBeenCalled();
    });

    it('enqueues resume when heartbeat is fresh (30s old)', async () => {
        vi.mocked(Run.findByPk).mockResolvedValueOnce({
            id: 'run-live',
            run_id: 'run-live',
            daemon_id: 'daemon-1',
        } as any);
        vi.mocked(Daemon.findByPk).mockResolvedValueOnce(make_daemon({
            id: 'daemon-1',
            last_heartbeat: Date.now() - 30_000,
        }) as any);

        const result = await DispatchService.resume('run-live', 'phase-x', [], 'user-1');

        expect(result).toEqual({ resumed: true, from_phase: 'phase-x' });
        expect(mock_enqueue).toHaveBeenCalledWith(
            'daemon-1',
            '/v1/resume',
            expect.objectContaining({ run_id: 'run-live', from_phase: 'phase-x' }),
        );
    });

    it('enforces observe-daemon access before enqueue', async () => {
        vi.mocked(Run.findByPk).mockResolvedValueOnce({
            id: 'run-noaccess',
            run_id: 'run-noaccess',
            daemon_id: 'daemon-1',
        } as any);
        vi.mocked(AccessService.assert_can_observe_daemon).mockRejectedValueOnce(
            new Error('forbidden: user lacks access to daemon'),
        );

        await expect(
            DispatchService.resume('run-noaccess', 'phase-1', [], 'user-1'),
        ).rejects.toThrow(/forbidden/i);

        expect(mock_enqueue).not.toHaveBeenCalled();
    });
});

// ── install_team ────────────────────────────────────────────────────

describe('DispatchService.install_team', () => {

    it('throws forbidden when user_id is missing', async () => {
        await expect(
            DispatchService.install_team({ team_id: 'team-1', user_id: '', daemon_ids: ['d1'] }),
        ).rejects.toThrow(/Not authenticated/);
    });

    it('throws bad_request when both daemon_ids and realm_id provided', async () => {
        await expect(
            DispatchService.install_team({
                team_id: 'team-1',
                user_id: 'user-1',
                daemon_ids: ['d1'],
                realm_id: 'realm-1',
            }),
        ).rejects.toThrow(/not both/i);
    });

    it('throws bad_request when neither daemon_ids nor realm_id provided', async () => {
        await expect(
            DispatchService.install_team({
                team_id: 'team-1',
                user_id: 'user-1',
            }),
        ).rejects.toThrow(/requires daemon_ids or realm_id/i);
    });

    it('throws not_found when team does not exist', async () => {
        vi.mocked(HubTeam.findByPk).mockResolvedValue(null as any);
        vi.mocked(HubTeam.findOne).mockResolvedValue(null as any);
        vi.mocked(TeamVersion.findOne).mockResolvedValue(null as any);
        vi.mocked(TeamVersion.findAll).mockResolvedValue([] as any);
        vi.mocked(Team.findByPk).mockResolvedValue(null as any);

        await expect(
            DispatchService.install_team({
                team_id: '999',
                user_id: 'user-1',
                daemon_ids: ['daemon-1'],
                scope_ids: ['scope-1'],
            }),
        ).rejects.toThrow(/not found/i);
    });

    it('enqueues install to each target daemon via outbox', async () => {
        const result = await DispatchService.install_team({
            team_id: '1',
            user_id: 'user-1',
            daemon_ids: ['daemon-1'],
            scope_ids: ['scope-1'],
        });

        expect(result.team_id).toBe('team-1');
        expect(result.results).toHaveLength(1);
        expect(result.results[0].ok).toBe(true);

        expect(mock_enqueue).toHaveBeenCalledWith(
            'daemon-1',
            '/v1/install',
            expect.objectContaining({
                scope: 'my-scope',
                slug: 'my-team',
            }),
        );
    });

    it('passes force:true in outbox payload when force is set', async () => {
        const result = await DispatchService.install_team({
            team_id: '1',
            user_id: 'user-1',
            daemon_ids: ['daemon-1'],
            scope_ids: ['scope-1'],
            force: true,
        });

        expect(result.results[0].ok).toBe(true);
        const payload = mock_enqueue.mock.calls[0][2] as Record<string, unknown>;
        expect(payload.force).toBe(true);
    });
});

// ── dispatch_claimed_run (team + workspace resolution) ──────────────

describe('DispatchService.dispatch_claimed_run', () => {
    const claimed_item = {
        id: 'q1',
        realm_id: 'realm-1',
        kind: 'run' as const,
        payload: {
            team_id: 'cliq/hello-world',
            run_name: 'ui-run',
        },
        status: 'claimed',
        claimed_by: 'daemon-1',
        priority: 0,
        submitted_by: '3',
        submitted_at: Date.now(),
        created_at: Date.now(),
        updated_at: Date.now(),
        results: null,
        error: null,
        run_id: null,
        claimed_at: Date.now(),
    };

    beforeEach(() => {
        vi.mocked(Scope.findOne).mockResolvedValue({ id: 'scope-cliq', slug: 'cliq' } as any);
        vi.mocked(Team.findByPk).mockResolvedValue(null as any);
        vi.mocked(Team.findOne).mockResolvedValue({
            id: 'team-daemon-row',
            daemon_id: 'daemon-1',
            scope_id: 'scope-cliq',
            slug: 'hello-world',
            manifest: 'name: x\nphases: []\n',
        } as any);
        vi.mocked(Workspace.findByPk).mockResolvedValue(null as any);
        vi.mocked(Workspace.findOne).mockResolvedValue(null as any);
        vi.mocked(Workspace.create).mockImplementation(async (row: any) => row);
        vi.mocked(QueueService.set_results).mockImplementation(async (id, patch) => ({
            ...claimed_item,
            id,
            ...patch,
        } as any));
        mock_fetch.mockResolvedValue(ok_response({ accepted: true }));
    });

    it('resolves scope/slug to the claiming daemon team row', async () => {
        const updated = await DispatchService.dispatch_claimed_run(claimed_item as any, {
            user_id: 'user-1',
            scope_ids: ['scope-cliq'],
        });

        expect(Team.findOne).toHaveBeenCalled();
        expect(RunService.create).toHaveBeenCalledWith(
            expect.any(String),
            'team-daemon-row',
            expect.objectContaining({ daemon_id: 'daemon-1' }),
        );
        expect(updated.status).toBe('running');
        expect(updated.run_id).toBe('run-001');
    });

    it('reuses an existing workspace when workspace_path already exists', async () => {
        vi.mocked(Workspace.findOne).mockResolvedValue({
            id: 'ws-existing',
            path: '/Users/me/proj',
            daemon_id: 'daemon-1',
        } as any);

        await DispatchService.dispatch_claimed_run(
            {
                ...claimed_item,
                payload: {
                    team_id: 'cliq/hello-world',
                    workspace_path: '/Users/me/proj',
                },
            } as any,
            { user_id: 'user-1', scope_ids: ['scope-cliq'] },
        );

        expect(Workspace.create).not.toHaveBeenCalled();
        expect(RunService.create).toHaveBeenCalledWith(
            'ws-existing',
            'team-daemon-row',
            expect.any(Object),
        );
    });

    it('fails clearly when scope/slug is not on the claiming daemon', async () => {
        vi.mocked(Team.findOne).mockResolvedValue(null as any);

        await expect(
            DispatchService.dispatch_claimed_run(claimed_item as any, {
                user_id: 'user-1',
            }),
        ).rejects.toThrow(/not installed on the claiming daemon/i);
    });
});

describe('DispatchService.offer_and_dispatch_run', () => {
    it('marks failed and throws when no online daemons', async () => {
        vi.mocked(RealmService.list_online_daemon_ids_in_realm).mockResolvedValueOnce([]);
        vi.mocked(QueueService.set_results).mockResolvedValueOnce({
            id: 'q1',
            status: 'failed',
            error: 'No online daemons in this realm — enroll a daemon and retry',
        } as any);

        await expect(
            DispatchService.offer_and_dispatch_run(
                {
                    id: 'q1',
                    realm_id: 'realm-1',
                    kind: 'run',
                    payload: { team_id: 'cliq/hello-world' },
                    status: 'queued',
                } as any,
                { user_id: 'user-1' },
            ),
        ).rejects.toThrow(/No online daemons/i);

        expect(QueueService.set_results).toHaveBeenCalledWith(
            'q1',
            expect.objectContaining({ status: 'failed' }),
        );
    });
});
