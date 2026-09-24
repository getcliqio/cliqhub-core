/**
 * Slice 1.3 — audit that RunService state transitions emit lifecycle
 * events onto the Hub event bus exactly once per transition. These
 * events power the JIRA plugin (and any other subscriber) — the
 * plugin needs `run.started` to post an "in progress" comment,
 * `run.completed` to close the issue, `run.failed`/`run.crashed`
 * to reopen it, and the phase.* events to render the "awaiting
 * input" badge.
 *
 * Verification hits the HubEvent row directly rather than the fan-out
 * layer so we're testing the emission contract, not delivery
 * side-effects (which are covered separately by fanout tests).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { randomUUID } from 'node:crypto';

import { RunService } from '../../src/services/run.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { ScopeService } from '../../src/services/control_scope_service.js';
import { TeamService } from '../../src/services/teams_install_service.js';
import { WorkspaceService } from '../../src/services/workspace.service.js';
import {
    close_test_control_plane_store,
    open_test_control_plane_store,
    postgres_reachable,
} from './helpers/control_plane_store.js';
import {
    Daemon,
    HubEvent,
    Realm,
    RealmMember,
    Run,
    RunEvent,
    RunPhase,
} from '../../src/models/index.js';

let workspace_id: string;
let team_id: string;
let scope_id: string;
let realm_id: string;
const daemon_id = randomUUID();
const has_postgres = await postgres_reachable();
const uid = () => `life-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
    if (!has_postgres) return;
    process.env.CLIQ_BFF_LOG_LEVEL = 'error';
    await open_test_control_plane_store();

    const scope = await ScopeService.add(`lc-scope-${uid()}`);
    scope_id = scope.id;
    const team = await TeamService.create(scope_id, `lc-team-${uid()}`, '1.0', null, '{}');
    team_id = team.get('id') as string;
    const { record } = await WorkspaceService.upsert_by_path(`/tmp/lc-ws-${uid()}`);
    workspace_id = record.id;

    await Daemon.create({
        id: daemon_id,
        api_key_hash: 'lc-test',
        user_id: hub_legacy_uuid(1),
        user_email: 'lc@test.local',
        hostname: 'lc-test',
        ip: null, port: null, public_url: null,
        status: 'online',
        last_heartbeat: Date.now(),
        capacity: 5,
        created_at: Date.now(),
        last_registered_at: Date.now(),
    });

    /** Seeded numeric user id — RealmService.create needs a real user row
     *  to resolve/create a personal org for the NOT NULL realms.org_id. */
    const realm = await RealmService.create(hub_legacy_uuid(1), `lc-${uid()}`.slice(0, 40), 'LC');
    realm_id = realm.id;
    // Daemon must be attributed to the realm so RunService.create
    // records realm_id and lifecycle events can route.
    await RealmMember.create({
        id: randomUUID(),
        realm_id,
        member_type: 'daemon',
        member_id: daemon_id,
        role: 'member',
        created_at: Date.now(),
    } as unknown as Record<string, unknown>);
});

beforeEach(async () => {
    if (!has_postgres) return;
    await RunEvent.destroy({ where: {} });
    await RunPhase.destroy({ where: {} });
    await Run.destroy({ where: {} });
    await HubEvent.destroy({ where: {} });
});

afterAll(async () => {
    if (!has_postgres) return;
    await HubEvent.destroy({ where: {} });
    await Run.destroy({ where: {} });
    await RealmMember.destroy({ where: { realm_id } });
    await Realm.destroy({ where: { id: realm_id } });
    await Daemon.destroy({ where: { id: daemon_id } });
    await close_test_control_plane_store();
});

async function events_for(run_id: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
    const rows = await HubEvent.findAll({
        where: { run_id },
        order: [['created_at', 'ASC']],
    });
    return rows.map((r) => {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse((r as unknown as { payload_json: string }).payload_json); } catch { /* ignore */ }
        return { type: r.type, payload };
    });
}

describe.skipIf(!has_postgres)('RunService lifecycle events', () => {

    it('create emits run.started once with realm/daemon context', async () => {
        const run_id = await RunService.create(workspace_id, team_id, {
            realm_id,
            daemon_id,
            run_name: 'lc-started',
        });
        const evs = await events_for(run_id);
        expect(evs.map((e) => e.type)).toEqual(['run.started']);
        expect(evs[0].payload.run_name).toBe('lc-started');
        expect(evs[0].payload.team_id).toBe(team_id);
    });

    it('idempotent re-create of an already-running run does not double-emit run.started', async () => {
        const run_id = await RunService.create(workspace_id, team_id, {
            realm_id, daemon_id, run_name: 'lc-idem',
        });
        await RunService.create(workspace_id, team_id, {
            run_id, realm_id, daemon_id, run_name: 'lc-idem',
        });
        const evs = await events_for(run_id);
        expect(evs.filter((e) => e.type === 'run.started')).toHaveLength(1);
    });

    it('re-create of a terminal run does emit run.started (real transition back into running)', async () => {
        const run_id = await RunService.create(workspace_id, team_id, {
            realm_id, daemon_id, run_name: 'lc-restart',
        });
        await RunService.complete(run_id, 'completed');
        await RunService.create(workspace_id, team_id, {
            run_id, realm_id, daemon_id, run_name: 'lc-restart',
        });
        const started = (await events_for(run_id)).filter((e) => e.type === 'run.started');
        expect(started).toHaveLength(2);
    });

    it.each([
        ['completed', 'run.completed'],
        ['failed', 'run.failed'],
        ['cancelled', 'run.cancelled'],
        ['crashed', 'run.crashed'],
    ] as const)('complete(%s) emits %s once', async (state, event_type) => {
        const run_id = await RunService.create(workspace_id, team_id, {
            realm_id, daemon_id, run_name: `lc-${state}`,
        });
        await RunService.complete(run_id, state, state === 'failed' ? 'boom' : undefined);
        const evs = await events_for(run_id);
        expect(evs.map((e) => e.type)).toContain(event_type);
        const terminal = evs.filter((e) => e.type === event_type);
        expect(terminal).toHaveLength(1);
        if (state === 'failed') {
            expect(terminal[0].payload.error).toBe('boom');
        }
    });

    it('complete is idempotent — re-reporting the same terminal state does not re-emit', async () => {
        const run_id = await RunService.create(workspace_id, team_id, {
            realm_id, daemon_id, run_name: 'lc-dup-complete',
        });
        await RunService.complete(run_id, 'completed');
        await RunService.complete(run_id, 'completed');
        await RunService.complete(run_id, 'completed');
        const done = (await events_for(run_id)).filter((e) => e.type === 'run.completed');
        expect(done).toHaveLength(1);
    });

    it('set_awaiting_input emits phase.input_required, resume emits phase.inputs_supplied', async () => {
        const run_id = await RunService.create(workspace_id, team_id, {
            realm_id, daemon_id, run_name: 'lc-await',
        });
        // Phase context is required by the schema; simulate the
        // daemon's set-current-phase call.
        await RunService.set_current_pid(run_id, 12345, 'plan');

        await RunService.set_awaiting_input(run_id);
        await RunService.set_awaiting_input(run_id); // Idempotent — no re-emit.
        await RunService.resume(run_id);
        await RunService.resume(run_id); // Idempotent — where clause gates.

        const evs = await events_for(run_id);
        expect(evs.filter((e) => e.type === 'phase.input_required')).toHaveLength(1);
        expect(evs.filter((e) => e.type === 'phase.inputs_supplied')).toHaveLength(1);
    });

    it('skips emit when run has no realm_id (nothing to route to)', async () => {
        const run_id = await RunService.create(workspace_id, team_id, {
            daemon_id, run_name: 'lc-no-realm',
        });
        await Run.update({ realm_id: null }, { where: { run_id } });
        await RunService.complete(run_id, 'completed');
        const evs = await events_for(run_id);
        // create still fired run.started (had realm at that moment via
        // daemon attribution) — but complete happened with realm=null,
        // so no run.completed row.
        expect(evs.filter((e) => e.type === 'run.completed')).toHaveLength(0);
    });

    it('crash_stale emits run.crashed for every still-running row on the daemon', async () => {
        const a = await RunService.create(workspace_id, team_id, {
            realm_id, daemon_id, run_name: 'lc-cs-a',
        });
        const b = await RunService.create(workspace_id, team_id, {
            realm_id, daemon_id, run_name: 'lc-cs-b',
        });
        await RunService.crash_stale(daemon_id);
        const crashed_a = (await events_for(a)).filter((e) => e.type === 'run.crashed');
        const crashed_b = (await events_for(b)).filter((e) => e.type === 'run.crashed');
        expect(crashed_a).toHaveLength(1);
        expect(crashed_b).toHaveLength(1);
        expect(crashed_a[0].payload.error).toBe('daemon restarted');
    });

    it('reaper emits run.crashed when it collects lease-expired rows', async () => {
        const { _reap_for_tests } = await import(
            '../../src/services/run_reaper.service.js'
        );

        const run_id = await RunService.create(workspace_id, team_id, {
            realm_id, daemon_id, run_name: 'lc-reap',
        });
        // Force the lease to already be expired; the reaper's WHERE
        // clause picks this up on the next scan.
        await Run.update(
            { lease_expires_at: Date.now() - 60_000 },
            { where: { run_id } },
        );

        await _reap_for_tests();

        const crashed = (await events_for(run_id)).filter((e) => e.type === 'run.crashed');
        expect(crashed).toHaveLength(1);
        expect(crashed[0].payload.error).toBe('run lease expired');
    });
});
