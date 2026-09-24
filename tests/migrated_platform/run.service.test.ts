import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import { RunService } from '../../src/services/run.service.js';
import { ScopeService } from '../../src/services/control_scope_service.js';
import { TeamService } from '../../src/services/teams_install_service.js';
import { WorkspaceService } from '../../src/services/workspace.service.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { Daemon, Run, RunEvent, RunLog, RunPhase, RunArtifact } from '../../src/models/index.js';
import { randomUUID } from 'node:crypto';

let workspace_id: string;
let team_id: string;
let scope_id: string;
const daemon_id = randomUUID();

const has_postgres = await postgres_reachable();

const uid = () => `run-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
    if (!has_postgres) return;
    process.env.CLIQ_BFF_LOG_LEVEL = 'error';
    await open_test_control_plane_store();

    const scope = await ScopeService.add(`run-test-scope-${uid()}`);
    scope_id = scope.id;

    const team = await TeamService.create(scope_id, `run-test-team-${uid()}`, '1.0', null, '{}');
    team_id = team.get('id') as string;

    const { record } = await WorkspaceService.upsert_by_path(`/tmp/run-test-ws-${uid()}`);
    workspace_id = record.id;
    await Daemon.create({
        id: daemon_id,
        api_key_hash: 'run-service-test',
        user_id: hub_legacy_uuid(1),
        user_email: 'platform@test.local',
        hostname: 'run-service-test',
        ip: null,
        port: null,
        public_url: null,
        status: 'online',
        last_heartbeat: Date.now(),
        capacity: 5,
        created_at: Date.now(),
        last_registered_at: Date.now(),
    });
});

async function cleanup_runs() {
    const runs = await Run.findAll({ where: { workspace_id }, attributes: ['run_id'] });
    const run_ids = runs.map((r) => r.get('run_id') as string);
    if (run_ids.length > 0) {
        await RunArtifact.destroy({ where: { run_id: run_ids } });
        await RunPhase.destroy({ where: { run_id: run_ids } });
        await RunLog.destroy({ where: { run_id: run_ids } });
        await RunEvent.destroy({ where: { run_id: run_ids } });
        await Run.destroy({ where: { workspace_id } });
    }
}

beforeEach(async () => {
    if (!has_postgres) return;
    await cleanup_runs();
});

afterAll(async () => {
    if (!has_postgres) return;
    await cleanup_runs();
    await Daemon.destroy({ where: { id: daemon_id } });
    await close_test_control_plane_store();
});

async function create_run(opts?: Parameters<typeof RunService.create>[2]) {
    return RunService.create(workspace_id, team_id, opts);
}

describe.skipIf(!has_postgres)('RunService — Core CRUD', () => {
    describe.skipIf(!has_postgres)('create + get', () => {
        it('creates a run and retrieves it by id', async () => {
            const run_id = await create_run({ run_name: 'test-run-crud' });
            expect(run_id).toBeTruthy();

            const run = await RunService.get(run_id);
            expect(run.get('workspace_id')).toBe(workspace_id);
            expect(run.get('team_id')).toBe(team_id);
            expect(run.get('state')).toBe('running');
        });

        it('ensures workspace + team link when workspace_path is provided', async () => {
            const fresh_id = randomUUID();
            const path = `/tmp/run-ensure-ws-${uid()}`;
            const run_id = await RunService.create(fresh_id, team_id, {
                daemon_id,
                workspace_path: path,
                workspace_name: 'ensure-me',
                run_name: 'ensure-ws-run',
            });
            const run = await RunService.get(run_id);
            expect(run.get('workspace_id')).toBe(fresh_id);

            const ws = await WorkspaceService.get(fresh_id);
            expect(ws.path).toBe(path);
            expect(ws.name).toBe('ensure-me');
            expect(ws.daemon_id).toBe(daemon_id);

            const teams = await WorkspaceService.list_teams(fresh_id);
            expect(teams.some((t) => t.get('team_id') === team_id)).toBe(true);

            await Run.destroy({ where: { run_id } });
            await WorkspaceService.remove(fresh_id);
        });

        it('creates run with custom inputs and execution_type', async () => {
            const run_id = await create_run({
                inputs: { prompt: 'hello' },
                execution_type: 'cloud',
            });
            const run = await RunService.get(run_id);
            expect(run.get('execution_type')).toBe('cloud');
            const inputs = JSON.parse(run.get('inputs') as string);
            expect(inputs.prompt).toBe('hello');
        });

        it('returns null for missing run', async () => {
            const result = await RunService.get(randomUUID());
            expect(result).toBeNull();
        });

        it('sets lease_expires_at on create and clears it on complete', async () => {
            const run_id = await create_run({ daemon_id, run_name: `lease-${uid()}` });
            const created = await Run.findByPk(run_id);
            const lease = Number(created!.get('lease_expires_at'));
            expect(lease).toBeGreaterThan(Date.now());
            // Running-lease TTL default is 60 min (bumped from 30 min in
            // c10b90a to keep long-phase teams like w2-parser from being
            // reaped mid-flight); use a 61-min bound to allow for a
            // handful of ms of clock drift between create and assert.
            expect(lease).toBeLessThan(Date.now() + 61 * 60 * 1000);

            await RunService.complete(run_id, 'completed');
            const done = await Run.findByPk(run_id);
            expect(done!.get('lease_expires_at')).toBeNull();
        });

        it('extends lease on phase progress and uses longer lease for awaiting_input', async () => {
            const run_id = await create_run({ daemon_id, run_name: `lease-phase-${uid()}` });
            await RunService.create_phases(run_id, [{ name: 'go', agent: 'exec' }]);

            const before = Number((await Run.findByPk(run_id))!.get('lease_expires_at'));
            await new Promise((r) => setTimeout(r, 5));
            await RunService.update_phase_status(run_id, 'go', 'running');
            const after_phase = Number((await Run.findByPk(run_id))!.get('lease_expires_at'));
            expect(after_phase).toBeGreaterThanOrEqual(before);

            await RunService.set_awaiting_input(run_id);
            const awaiting = Number((await Run.findByPk(run_id))!.get('lease_expires_at'));
            expect(awaiting).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
        });
    });

    describe.skipIf(!has_postgres)('get_by_name', () => {
        it('returns run by name', async () => {
            const name = `named-${Date.now()}`;
            await create_run({ run_name: name });

            const run = await RunService.get_by_name(name);
            expect(run.get('run_name')).toBe(name);
        });

        it('returns null for unknown name', async () => {
            const result = await RunService.get_by_name('nonexistent');
            expect(result).toBeNull();
        });
    });

    describe.skipIf(!has_postgres)('resolve', () => {
        it('resolves by id', async () => {
            const run_id = await create_run();
            const run = await RunService.resolve(run_id);
            expect(run.get('run_id')).toBe(run_id);
        });

        it('resolves by name', async () => {
            const name = `resolve-${Date.now()}`;
            await create_run({ run_name: name });

            const run = await RunService.resolve(name);
            expect(run.get('run_name')).toBe(name);
        });

        it('returns null for unknown ref', async () => {
            const result = await RunService.resolve('nonexistent');
            expect(result).toBeNull();
        });
    });

    describe.skipIf(!has_postgres)('list_recent', () => {
        it('returns paginated runs + total', async () => {
            const result = await RunService.list_recent();
            expect(Array.isArray(result.runs)).toBe(true);
            expect(typeof result.total).toBe('number');
        });

        it('returns runs ordered by started_at DESC', async () => {
            await create_run({ run_name: 'first' });
            await create_run({ run_name: 'second' });

            const result = await RunService.list_recent();
            expect(result.runs.length).toBeGreaterThanOrEqual(2);
            const times = result.runs.map((r: any) => Number(r.started_at ?? r.get?.('started_at')));
            expect(times[0]).toBeGreaterThanOrEqual(times[1]);
        });

        it('filters by daemon_id when provided', async () => {
            await create_run({ daemon_id });
            const result = await RunService.list_recent(20, daemon_id);
            expect(result.runs.every((r: any) => r.daemon_id === daemon_id)).toBe(true);
        });

        it('realm filter is strict — never leaks runs from another realm', async () => {
            // Two realms, one shared daemon (the shape that made the
            // prod 99a2f0f1 fossil bleed cross-realm). Filtering by
            // realm_id must return runs snapshotted for THAT realm
            // only, not everything the daemon has ever run.
            const realm_a = `test-realm-a-${uid()}`;
            const realm_b = `test-realm-b-${uid()}`;

            const in_a = await create_run({ daemon_id, realm_id: realm_a });
            const in_b = await create_run({ daemon_id, realm_id: realm_b });

            const list_a = await RunService.list_recent(50, undefined, { realm_id: realm_a });
            const ids_a = list_a.runs.map((r: any) => r.run_id);
            expect(ids_a).toContain(in_a);
            expect(ids_a).not.toContain(in_b);

            const list_b = await RunService.list_recent(50, undefined, { realm_id: realm_b });
            const ids_b = list_b.runs.map((r: any) => r.run_id);
            expect(ids_b).toContain(in_b);
            expect(ids_b).not.toContain(in_a);
        });

        it('hides legacy realm_id=NULL runs from realm-scoped listings', async () => {
            // Pre-realm_id rows (daemon_id set, realm_id NULL). These
            // must not appear under any realm — we deliberately dropped
            // the daemon-hop fallback that used to expose them (and
            // leaked cross-user).
            const realm_id = `test-realm-legacy-${uid()}`;
            const legacy_run = await create_run({ daemon_id });
            // Force realm_id NULL to simulate a pre-migration row.
            await Run.update({ realm_id: null }, { where: { run_id: legacy_run } });

            const listed = await RunService.list_recent(50, undefined, { realm_id });
            expect(listed.runs.map((r: any) => r.run_id)).not.toContain(legacy_run);
        });
    });

    describe.skipIf(!has_postgres)('list_by_workspace', () => {
        it('returns runs for specific workspace', async () => {
            await create_run();

            const result = await RunService.list_by_workspace(workspace_id);
            result.runs.forEach((r: any) => expect(r.workspace_id).toBe(workspace_id));
        });
    });
});

describe.skipIf(!has_postgres)('RunService — State transitions', () => {
    describe.skipIf(!has_postgres)('complete', () => {
        it('marks run as completed', async () => {
            const run_id = await create_run();
            await RunService.complete(run_id, 'completed');

            const run = await RunService.get(run_id);
            expect(run.get('state')).toBe('completed');
            expect(run.get('completed_at')).not.toBeNull();
            expect(run.get('error')).toBeNull();
        });

        it('marks run as failed with error message', async () => {
            const run_id = await create_run();
            await RunService.complete(run_id, 'failed', 'something broke');

            const run = await RunService.get(run_id);
            expect(run.get('state')).toBe('failed');
            expect(run.get('error')).toBe('something broke');
        });

        it('marks run as cancelled', async () => {
            const run_id = await create_run();
            await RunService.complete(run_id, 'cancelled');

            const run = await RunService.get(run_id);
            expect(run.get('state')).toBe('cancelled');
        });

        it('marks run as crashed', async () => {
            const run_id = await create_run();
            await RunService.complete(run_id, 'crashed', 'daemon died');

            const run = await RunService.get(run_id);
            expect(run.get('state')).toBe('crashed');
            expect(run.get('error')).toBe('daemon died');
        });
    });

    describe.skipIf(!has_postgres)('set_awaiting_input + resume', () => {
        it('transitions running → awaiting_input → running', async () => {
            const run_id = await create_run();

            await RunService.set_awaiting_input(run_id);
            let run = await RunService.get(run_id);
            expect(run.get('state')).toBe('awaiting_input');

            await RunService.resume(run_id);
            run = await RunService.get(run_id);
            expect(run.get('state')).toBe('running');
        });
    });

    describe.skipIf(!has_postgres)('restart', () => {
        it('restarts a completed run', async () => {
            const run_id = await create_run();
            await RunService.complete(run_id, 'failed', 'err');
            await RunService.restart(run_id);

            const run = await RunService.get(run_id);
            expect(run.get('state')).toBe('running');
            expect(run.get('error')).toBeNull();
        });
    });

    describe.skipIf(!has_postgres)('set_inputs', () => {
        it('sets inputs on a run', async () => {
            const run_id = await create_run();
            await RunService.set_inputs(run_id, { answer: 42 });

            const run = await RunService.get(run_id);
            const inputs = JSON.parse(run.get('inputs') as string);
            expect(inputs.answer).toBe(42);
        });
    });

    describe.skipIf(!has_postgres)('set_current_pid / clear_current_pid', () => {
        it('sets and clears pid', async () => {
            const run_id = await create_run();
            await RunService.set_current_pid(run_id, 12345, 'plan');

            let run = await RunService.get(run_id);
            expect(run.get('current_pid')).toBe(12345);
            expect(run.get('current_phase')).toBe('plan');

            await RunService.clear_current_pid(run_id);
            run = await RunService.get(run_id);
            expect(run.get('current_pid')).toBeNull();
            expect(run.get('current_phase')).toBeNull();
        });
    });

    describe.skipIf(!has_postgres)('crash_stale', () => {
        it('marks all running runs as crashed', async () => {
            await create_run();
            await create_run();

            const count = await RunService.crash_stale();
            expect(count).toBeGreaterThanOrEqual(2);

            const active = await RunService.list_active(workspace_id);
            expect(active).toHaveLength(0);
        });
    });

    describe.skipIf(!has_postgres)('list_children', () => {
        it('returns child runs', async () => {
            const parent_id = await create_run();
            await create_run({ parent_run_id: parent_id, parent_phase: 'build' });
            await create_run({ parent_run_id: parent_id, parent_phase: 'test' });

            const children = await RunService.list_children(parent_id);
            expect(children).toHaveLength(2);
        });
    });

    describe.skipIf(!has_postgres)('delete_by_workspace', () => {
        it('deletes all runs for a workspace', async () => {
            await create_run();
            await create_run();

            const count = await RunService.delete_by_workspace(workspace_id);
            expect(count).toBeGreaterThanOrEqual(2);

            const remaining = await RunService.list_by_workspace(workspace_id);
            expect(remaining.runs).toHaveLength(0);
        });
    });
});

describe.skipIf(!has_postgres)('RunService — Events', () => {
    describe.skipIf(!has_postgres)('append_event + list_events', () => {
        it('appends and lists events', async () => {
            const run_id = await create_run();
            const event_id = await RunService.append_event(run_id, 'phase_start', 'plan', 'planner');
            expect(typeof event_id).toBe('string');
            expect(event_id.length).toBeGreaterThan(0);

            const events = await RunService.list_events(run_id);
            expect(events).toHaveLength(1);
            expect(events[0].get('event_type')).toBe('phase_start');
            expect(events[0].get('phase')).toBe('plan');
        });

        it('appends event with payload', async () => {
            const run_id = await create_run();
            await RunService.append_event(run_id, 'output', 'build', 'builder', { line: 'hello' });

            const events = await RunService.list_events(run_id);
            const payload = JSON.parse(events[0].get('payload_json') as string);
            expect(payload.line).toBe('hello');
        });
    });

    describe.skipIf(!has_postgres)('list_events_after', () => {
        it('returns only events after given id', async () => {
            const run_id = await create_run();
            const id_1 = await RunService.append_event(run_id, 'a');
            await RunService.append_event(run_id, 'b');
            await RunService.append_event(run_id, 'c');

            const after = await RunService.list_events_after(run_id, id_1);
            expect(after).toHaveLength(2);
        });
    });

    describe.skipIf(!has_postgres)('count_events', () => {
        it('returns correct count', async () => {
            const run_id = await create_run();
            await RunService.append_event(run_id, 'x');
            await RunService.append_event(run_id, 'y');

            const count = await RunService.count_events(run_id);
            expect(count).toBe(2);
        });

        it('returns 0 for run with no events', async () => {
            const run_id = await create_run();
            const count = await RunService.count_events(run_id);
            expect(count).toBe(0);
        });
    });

    describe.skipIf(!has_postgres)('delete_events', () => {
        it('deletes all events for a run', async () => {
            const run_id = await create_run();
            await RunService.append_event(run_id, 'x');
            await RunService.append_event(run_id, 'y');

            const deleted = await RunService.delete_events(run_id);
            expect(deleted).toBe(2);

            const remaining = await RunService.list_events(run_id);
            expect(remaining).toHaveLength(0);
        });
    });
});

describe.skipIf(!has_postgres)('RunService — Logs', () => {
    describe.skipIf(!has_postgres)('append_log + get_log', () => {
        it('appends log chunks and retrieves full log', async () => {
            const run_id = await create_run();
            const id_1 = await RunService.append_log(run_id, 'hello ');
            const id_2 = await RunService.append_log(run_id, 'world');

            expect(typeof id_1).toBe('string');
            expect(typeof id_2).toBe('string');
            expect(id_1).toBeTruthy();
            expect(id_2).toBeTruthy();
            expect(id_2).not.toBe(id_1);

            const full_log = await RunService.get_log(run_id);
            expect(full_log).toBe('hello world');
        });

        it('returns empty string for run with no logs', async () => {
            const run_id = await create_run();
            const log = await RunService.get_log(run_id);
            expect(log).toBe('');
        });
    });

    describe.skipIf(!has_postgres)('get_log_chunks', () => {
        it('returns log chunks after a given id', async () => {
            const run_id = await create_run();
            const id_1 = await RunService.append_log(run_id, 'chunk1');
            await RunService.append_log(run_id, 'chunk2');
            await RunService.append_log(run_id, 'chunk3');

            const chunks = await RunService.get_log_chunks(run_id, id_1);
            expect(chunks).toHaveLength(2);
        });
    });

    describe.skipIf(!has_postgres)('log_size', () => {
        it('returns 0 for run with no logs', async () => {
            const run_id = await create_run();
            const size = await RunService.log_size(run_id);
            expect(size).toBe(0);
        });

        it('returns total byte size of log chunks', async () => {
            const run_id = await create_run();
            await RunService.append_log(run_id, 'abcde');
            await RunService.append_log(run_id, '12345');

            const size = await RunService.log_size(run_id);
            expect(size).toBe(10);
        });
    });

    describe.skipIf(!has_postgres)('delete_logs', () => {
        it('deletes all logs for a run', async () => {
            const run_id = await create_run();
            await RunService.append_log(run_id, 'chunk1');
            await RunService.append_log(run_id, 'chunk2');

            const deleted = await RunService.delete_logs(run_id);
            expect(deleted).toBe(2);

            const log = await RunService.get_log(run_id);
            expect(log).toBe('');
        });
    });

    describe.skipIf(!has_postgres)('append_log — size limit', () => {
        it('returns -1 when log exceeds max size', async () => {
            const run_id = await create_run();
            const big_chunk = 'x'.repeat(10 * 1024 * 1024);
            await RunService.append_log(run_id, big_chunk);

            const result = await RunService.append_log(run_id, 'one more byte');
            expect(result).toBeNull();
        });
    });

    describe.skipIf(!has_postgres)('search_log_lines — concern filter + facets', () => {
        it('stamps concern per append, filters by concern, and returns concern facets', async () => {
            const run_id = await create_run();
            await RunService.append_log(run_id, 'run-line-a\nrun-line-b\n');
            await RunService.append_log(run_id, 'run-line-c\n', { concern: 'run' });
            await RunService.append_log(
                run_id,
                '→ Daemon received Resume (tx abcdef01)\n',
                { concern: 'command' },
            );

            // No concern filter — all lines present, both buckets in facets.
            const all = await RunService.search_log_lines({ run_ids: [run_id] });
            const total_lines = all.lines.length;
            expect(total_lines).toBe(4);
            for (const line of all.lines) {
                expect(['run', 'command']).toContain(line.concern);
            }
            const bucket_map = new Map(all.facets.concern.map((b) => [b.value, b.count]));
            expect(bucket_map.get('run')).toBe(3);
            expect(bucket_map.get('command')).toBe(1);

            // Whitelist filter — only the breadcrumb comes back.
            const command_only = await RunService.search_log_lines({
                run_ids: [run_id],
                concerns: ['command'],
            });
            expect(command_only.lines).toHaveLength(1);
            expect(command_only.lines[0].concern).toBe('command');
            expect(command_only.lines[0].message).toContain('Daemon received Resume');

            // Multi-value whitelist — both concerns pass.
            const both = await RunService.search_log_lines({
                run_ids: [run_id],
                concerns: ['run', 'command'],
            });
            expect(both.lines).toHaveLength(4);
        });
    });
});

describe.skipIf(!has_postgres)('RunService — Phases', () => {
    describe.skipIf(!has_postgres)('create_phases + list_phases', () => {
        it('creates multiple phases and lists them', async () => {
            const run_id = await create_run();
            await RunService.create_phases(run_id, [
                { name: 'plan', agent: 'planner' },
                { name: 'build', agent: 'builder' },
                { name: 'test' },
            ]);

            const phases = await RunService.list_phases(run_id);
            expect(phases).toHaveLength(3);
            // list_phases now returns enriched plain objects (see
            // _enrich_phase_rows in 9602a8a) — the DAG needs manifest-
            // derived fields folded in, so we can't return Sequelize
            // instances. Use property access, not the `.get()` method.
            const names = phases.map((p) => p.phase);
            expect(names).toContain('plan');
            expect(names).toContain('build');
            expect(names).toContain('test');
        });

        it('does nothing when given empty array', async () => {
            const run_id = await create_run();
            await RunService.create_phases(run_id, []);
            const phases = await RunService.list_phases(run_id);
            expect(phases).toHaveLength(0);
        });

        it('is idempotent — does not duplicate phases', async () => {
            const run_id = await create_run();
            await RunService.create_phases(run_id, [{ name: 'plan' }]);
            await RunService.create_phases(run_id, [{ name: 'plan' }]);

            const phases = await RunService.list_phases(run_id);
            expect(phases).toHaveLength(1);
        });
    });

    describe.skipIf(!has_postgres)('find_phase', () => {
        it('returns specific phase', async () => {
            const run_id = await create_run();
            await RunService.create_phases(run_id, [{ name: 'review', agent: 'reviewer' }]);

            const phase = await RunService.find_phase(run_id, 'review');
            expect(phase).not.toBeNull();
            expect(phase!.get('agent_name')).toBe('reviewer');
        });

        it('returns null for unknown phase', async () => {
            const run_id = await create_run();
            const phase = await RunService.find_phase(run_id, 'unknown');
            expect(phase).toBeNull();
        });
    });

    describe.skipIf(!has_postgres)('update_phase_status', () => {
        it('updates status to running (sets dispatched_at)', async () => {
            const run_id = await create_run();
            await RunService.create_phases(run_id, [{ name: 'build' }]);
            await RunService.update_phase_status(run_id, 'build', 'running');

            const phase = await RunService.find_phase(run_id, 'build');
            expect(phase!.get('status')).toBe('running');
            expect(phase!.get('dispatched_at')).not.toBeNull();
        });

        it('updates status to done (sets completed_at)', async () => {
            const run_id = await create_run();
            await RunService.create_phases(run_id, [{ name: 'build' }]);
            await RunService.update_phase_status(run_id, 'build', 'done', { exit_code: 0 });

            const phase = await RunService.find_phase(run_id, 'build');
            expect(phase!.get('status')).toBe('done');
            expect(phase!.get('completed_at')).not.toBeNull();
            expect(phase!.get('exit_code')).toBe(0);
        });

        it('updates status to failed with error', async () => {
            const run_id = await create_run();
            await RunService.create_phases(run_id, [{ name: 'test' }]);
            await RunService.update_phase_status(run_id, 'test', 'failed', {
                exit_code: 1,
                error: 'tests failed',
            });

            const phase = await RunService.find_phase(run_id, 'test');
            expect(phase!.get('status')).toBe('failed');
            expect(phase!.get('error')).toBe('tests failed');
        });

        it('updates status to skipped (sets completed_at)', async () => {
            const run_id = await create_run();
            await RunService.create_phases(run_id, [{ name: 'optional' }]);
            await RunService.update_phase_status(run_id, 'optional', 'skipped');

            const phase = await RunService.find_phase(run_id, 'optional');
            expect(phase!.get('status')).toBe('skipped');
            expect(phase!.get('completed_at')).not.toBeNull();
        });
    });

    describe.skipIf(!has_postgres)('list_phases_by_status', () => {
        it('filters phases by status', async () => {
            const run_id = await create_run();
            await RunService.create_phases(run_id, [
                { name: 'plan' },
                { name: 'build' },
            ]);
            await RunService.update_phase_status(run_id, 'plan', 'done');

            const done = await RunService.list_phases_by_status(run_id, 'done');
            expect(done).toHaveLength(1);
            // Enriched plain objects — see note in "creates multiple
            // phases and lists them" above.
            expect(done[0].phase).toBe('plan');

            const pending = await RunService.list_phases_by_status(run_id, 'pending');
            expect(pending).toHaveLength(1);
            expect(pending[0].phase).toBe('build');
        });
    });

    describe.skipIf(!has_postgres)('reset_phase', () => {
        it('resets phase back to pending', async () => {
            const run_id = await create_run();
            await RunService.create_phases(run_id, [{ name: 'build' }]);
            await RunService.update_phase_status(run_id, 'build', 'done', { exit_code: 0 });

            await RunService.reset_phase(run_id, 'build');
            const phase = await RunService.find_phase(run_id, 'build');
            expect(phase!.get('status')).toBe('pending');
            expect(phase!.get('completed_at')).toBeNull();
            expect(phase!.get('exit_code')).toBeNull();
        });
    });

    describe.skipIf(!has_postgres)('delete_phases', () => {
        it('deletes all phases for a run', async () => {
            const run_id = await create_run();
            await RunService.create_phases(run_id, [{ name: 'a' }, { name: 'b' }]);

            const deleted = await RunService.delete_phases(run_id);
            expect(deleted).toBe(2);

            const remaining = await RunService.list_phases(run_id);
            expect(remaining).toHaveLength(0);
        });
    });
});

describe.skipIf(!has_postgres)('RunService — Artifacts', () => {
    describe.skipIf(!has_postgres)('create_artifact + list_artifacts_by_phase', () => {
        it('creates an artifact and retrieves by phase', async () => {
            const run_id = await create_run();
            const id = await RunService.create_artifact({
                run_id,
                phase: 'plan',
                kind: 'output',
                name: 'design.md',
                content: '# Design\n\nThe design.',
                mime_type: 'text/markdown',
                target_phase: 'build',
                sequence: 3,
            });

            expect(typeof id).toBe('string');
            expect(id.length).toBeGreaterThan(0);

            const artifacts = await RunService.list_artifacts_by_phase(run_id, 'plan');
            expect(artifacts).toHaveLength(1);
            expect(artifacts[0].get('name')).toBe('design.md');
            expect(artifacts[0].get('target_phase')).toBe('build');
            expect(artifacts[0].get('sequence')).toBe(3);
        });

        it('create_artifact upserts on run_id+phase+kind+name', async () => {
            const run_id = await create_run();
            await RunService.create_artifact({
                run_id, phase: 'plan', kind: 'output', name: 'phase_output', content: 'v1',
            });
            await RunService.create_artifact({
                run_id, phase: 'plan', kind: 'output', name: 'phase_output', content: 'v2',
            });
            const artifacts = await RunService.list_artifacts_by_phase(run_id, 'plan');
            const outputs = artifacts.filter((a) => a.get('name') === 'phase_output');
            expect(outputs).toHaveLength(1);
            expect(outputs[0].get('content')).toBe('v2');
        });
    });

    describe.skipIf(!has_postgres)('list_artifacts_by_kind', () => {
        it('filters artifacts by kind', async () => {
            const run_id = await create_run();
            await RunService.create_artifact({
                run_id, phase: 'plan', kind: 'output', name: 'a.md', content: 'a',
            });
            await RunService.create_artifact({
                run_id, phase: 'plan', kind: 'handoff', name: 'b.md', content: 'b',
                target_phase: 'build',
            });

            const outputs = await RunService.list_artifacts_by_kind(run_id, 'output');
            expect(outputs).toHaveLength(1);
            expect(outputs[0].get('name')).toBe('a.md');
        });
    });

    describe.skipIf(!has_postgres)('append_handoff + list_handoffs_for', () => {
        it('appends handoff artifact with auto-sequence', async () => {
            const run_id = await create_run();
            const id_1 = await RunService.append_handoff(run_id, 'plan', 'build', 'spec.md', 'spec content');
            const id_2 = await RunService.append_handoff(run_id, 'plan', 'build', 'notes.md', 'notes content');

            expect(typeof id_1).toBe('string');
            expect(typeof id_2).toBe('string');
            expect(id_1).toBeTruthy();
            expect(id_2).not.toBe(id_1);

            const handoffs = await RunService.list_handoffs_for(run_id, 'build');
            expect(handoffs).toHaveLength(2);
            expect(handoffs[0].get('sequence')).toBe(0);
            expect(handoffs[1].get('sequence')).toBe(1);
        });
    });

    describe.skipIf(!has_postgres)('list_artifacts', () => {
        it('returns all artifacts for a run', async () => {
            const run_id = await create_run();
            await RunService.create_artifact({
                run_id, phase: 'plan', kind: 'output', name: 'a.md', content: 'a',
            });
            await RunService.create_artifact({
                run_id, phase: 'build', kind: 'output', name: 'b.md', content: 'b',
            });

            const all = await RunService.list_artifacts(run_id);
            expect(all).toHaveLength(2);
        });
    });

    describe.skipIf(!has_postgres)('delete_artifacts', () => {
        it('deletes all artifacts for a run', async () => {
            const run_id = await create_run();
            await RunService.create_artifact({
                run_id, phase: 'plan', kind: 'output', name: 'a.md', content: 'a',
            });
            await RunService.create_artifact({
                run_id, phase: 'build', kind: 'output', name: 'b.md', content: 'b',
            });

            const deleted = await RunService.delete_artifacts(run_id);
            expect(deleted).toBe(2);

            const remaining = await RunService.list_artifacts(run_id);
            expect(remaining).toHaveLength(0);
        });

        it('returns 0 when no artifacts exist', async () => {
            const run_id = await create_run();
            const deleted = await RunService.delete_artifacts(run_id);
            expect(deleted).toBe(0);
        });
    });
});

