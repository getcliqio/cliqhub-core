/**
 * realms/get with counts (real Postgres): `with_stats` adds people, daemons online now and runs
 * running or awaiting input to each realm; `sort_by` members / online_daemons / active_runs sorts
 * by those counts in the database, across pages.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { Daemon, RealmMember, Run } from '../../src/models/index.js';
import { RealmService } from '../../src/services/realm.service.js';
import { ScopeService } from '../../src/services/control_scope_service.js';
import { TeamService } from '../../src/services/teams_install_service.js';
import { WorkspaceService } from '../../src/services/workspace.service.js';

const has_postgres = await postgres_reachable();
const owner = hub_legacy_uuid(1);
const uid = () => `rls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('realms/get counts and sorting by them', () => {
    const prefix = uid().slice(0, 20);
    const ids: Record<string, string> = {};

    async function daemon(realm_id: string, status: 'online' | 'offline') {
        const id = randomUUID();
        await Daemon.create({ id, api_key_hash: 'h', user_id: null, user_email: null, hostname: 'h', ip: '127.0.0.1', port: 4900, public_url: `https://d.test/${id}`, status, last_heartbeat: Date.now(), capacity: 5, created_at: Date.now(), last_registered_at: Date.now() } as any);
        await RealmService.upsert_daemon_member(realm_id, id);
    }

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
        const scope = await ScopeService.add(`${prefix}-scope`);
        const team = await TeamService.create(scope.id, `${prefix}-team`, '1.0', null, '{}');
        const { record } = await WorkspaceService.upsert_by_path(`/tmp/${prefix}-ws`);
        const run = (realm_id: string, state: string) => Run.create({
            run_id: randomUUID(), workspace_id: record.id, team_id: team.get('id') as string, daemon_id: null, realm_id,
            parent_run_id: null, parent_phase: null, run_name: 'r', state, inputs: null, error: null, execution_type: 'local',
            current_pid: null, current_phase: null, external_id: null, context_labels: null, started_at: Date.now(), completed_at: null,
        } as any);

        // a: 3 people, 1 daemon online (+1 offline), 0 active runs
        // b: 1 person, 2 daemons online, 2 active runs (+1 completed)
        for (const k of ['a', 'b']) ids[k] = (await RealmService.create(owner, `${prefix}-${k}`, `${prefix} ${k}`)).id;
        for (const n of [2, 3]) await RealmMember.create({ id: randomUUID(), realm_id: ids.a, member_type: 'user', member_id: hub_legacy_uuid(n), role: 'member', created_at: Date.now() } as any);
        await daemon(ids.a, 'online'); await daemon(ids.a, 'offline');
        await daemon(ids.b, 'online'); await daemon(ids.b, 'online');
        await run(ids.b, 'running'); await run(ids.b, 'awaiting_input'); await run(ids.b, 'completed');
    });
    afterAll(async () => { await close_test_control_plane_store(); });

    const list = (extra: Record<string, unknown>) => RealmService.list_for_user(owner, { query: prefix, with_stats: true, ...extra });

    it('with_stats: people, daemons online now, runs running or awaiting input', async () => {
        const { realms } = await list({});
        const by = Object.fromEntries(realms.map((r: any) => [r.id, r]));
        expect(by[ids.a]).toMatchObject({ member_count: 3, online_daemons: 1, active_runs: 0 });
        expect(by[ids.b]).toMatchObject({ member_count: 1, online_daemons: 2, active_runs: 2 });
    });

    it('sorts by each count, both ways, and pages stably', async () => {
        const order = async (sort_by: string, sort_dir: 'asc' | 'desc') => (await list({ sort_by, sort_dir })).realms.map((r) => r.id);
        expect(await order('members', 'desc')).toEqual([ids.a, ids.b]);
        expect(await order('members', 'asc')).toEqual([ids.b, ids.a]);
        expect(await order('online_daemons', 'desc')).toEqual([ids.b, ids.a]);
        expect(await order('active_runs', 'desc')).toEqual([ids.b, ids.a]);
        const page = await list({ sort_by: 'active_runs', sort_dir: 'desc', limit: 1, offset: 1 });
        expect(page.total).toBe(2);
        expect(page.realms.map((r) => r.id)).toEqual([ids.a]);
    });

    it('without with_stats nothing extra is read or returned', async () => {
        const { realms } = await RealmService.list_for_user(owner, { query: prefix });
        expect(realms.every((r: any) => r.member_count === undefined)).toBe(true);
    });
});
