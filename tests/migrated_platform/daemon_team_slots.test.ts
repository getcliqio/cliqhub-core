/**
 * Daemon team slots (PLAN-team-ids.md): one id per (daemon, scope, slug) for
 * life — register, CliqHub install, sync and uninstall all keep it, and runs
 * keep their team after an uninstall.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { RunService } from '../../src/services/run.service.js';
import { ScopeService } from '../../src/services/control_scope_service.js';
import { TeamService } from '../../src/services/teams_install_service.js';
import { WorkspaceService } from '../../src/services/workspace.service.js';
import { DaemonTeamCacheService } from '../../src/services/daemon_team_cache.service.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { Daemon, DaemonTeam, Run } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let scope_slug: string;
let workspace_id: string;
const daemons: string[] = [];

async function new_daemon(): Promise<string> {
    const id = randomUUID();
    await Daemon.create({
        id, api_key_hash: 'slot-test', user_id: hub_legacy_uuid(1), user_email: 'platform@test.local',
        hostname: 'slot-test', ip: null, port: null, public_url: null, status: 'online',
        last_heartbeat: Date.now(), capacity: 5, created_at: Date.now(), last_registered_at: Date.now(),
    });
    daemons.push(id);
    return id;
}

const team = (slug: string, id?: string) => ({ id: id ?? randomUUID(), scope: scope_slug, slug, version: '1.0', manifest: 'phases: []' });

/** The slot row, installed or not. */
const slot = (daemon_id: string, slug: string) => DaemonTeam.unscoped().findOne({ where: { daemon_id, slug } });

/** The team label a run shows (the run list read). */
async function run_label(run_id: string, workspace: string): Promise<string | null> {
    const { runs } = await RunService.list_recent(50, undefined, { workspace_id: workspace, site_admin: true });
    return (runs.find((r: { run_id: string }) => r.run_id === run_id) as { team_label?: string | null } | undefined)?.team_label ?? null;
}

beforeAll(async () => {
    if (!has_postgres) return;
    process.env.CLIQ_BFF_LOG_LEVEL = 'error';
    await open_test_control_plane_store();
    scope_slug = `slots-${uid()}`;
    await ScopeService.add(scope_slug);
    const { record } = await WorkspaceService.upsert_by_path(`/tmp/slot-test-ws-${uid()}`);
    workspace_id = record.id;
});

afterAll(async () => {
    if (!has_postgres) return;
    await Run.destroy({ where: { workspace_id } });
    await DaemonTeam.unscoped().destroy({ where: { daemon_id: daemons } });
    await Daemon.destroy({ where: { id: daemons } });
    await close_test_control_plane_store();
});

describe.skipIf(!has_postgres)('daemon team slots', () => {
    it('S1: a new team takes the id the daemon proposes', async () => {
        const d = await new_daemon();
        const t = team('qa');
        const [out] = await TeamService.register_from_daemon(d, [t], false);
        expect(out).toEqual({ scope: scope_slug, slug: 'qa', id: t.id });
    });

    it('S2: an existing slot keeps its id; the daemon is told to use it and its runs move', async () => {
        const d = await new_daemon();
        const first = team('qa');
        await TeamService.register_from_daemon(d, [first], false);
        // The daemon reinstalled offline and minted another id, then ran the team.
        const local = randomUUID();
        const run_id = await RunService.create(workspace_id, local, { daemon_id: d });
        const [out] = await TeamService.register_from_daemon(d, [team('qa', local)], false);
        expect(out!.id).toBe(first.id);
        expect((await Run.findByPk(run_id))!.get('team_id')).toBe(first.id);
    });

    it('S3/S4: uninstall keeps the slot (runs keep their team); reinstall gets the same id back', async () => {
        const d = await new_daemon();
        const t = team('qa');
        await TeamService.register_from_daemon(d, [t], true);
        const run_id = await RunService.create(workspace_id, t.id, { daemon_id: d });

        // The daemon's whole roster no longer has it → uninstalled, not deleted.
        await TeamService.register_from_daemon(d, [], true);
        expect((await slot(d, 'qa'))!.get('uninstalled_at')).not.toBeNull();
        expect(await DaemonTeam.findOne({ where: { daemon_id: d, slug: 'qa' } })).toBeNull();
        expect(await run_label(run_id, workspace_id)).toBe(`@${scope_slug}/qa`);

        const [again] = await TeamService.register_from_daemon(d, [team('qa')], true);
        expect(again!.id).toBe(t.id);
        expect((await slot(d, 'qa'))!.get('uninstalled_at')).toBeNull();
    });

    it('a proposed id already used by another slot is not reused', async () => {
        const d1 = await new_daemon();
        const d2 = await new_daemon();
        const t = team('qa');
        await TeamService.register_from_daemon(d1, [t], false);
        const [out] = await TeamService.register_from_daemon(d2, [team('qa', t.id)], false);
        expect(out!.id).not.toBe(t.id);
    });

    it('S11: two daemons, same team — two slots, no cross-claiming', async () => {
        const d1 = await new_daemon();
        const d2 = await new_daemon();
        const a = team('shared');
        const b = team('shared');
        await TeamService.register_from_daemon(d1, [a], false);
        await TeamService.register_from_daemon(d2, [b], false);
        expect((await slot(d1, 'shared'))!.id).toBe(a.id);
        expect((await slot(d2, 'shared'))!.id).toBe(b.id);
    });

    it('an unknown scope is refused per team, never created', async () => {
        const d = await new_daemon();
        const [out] = await TeamService.register_from_daemon(d, [{ ...team('x'), scope: `nope-${uid()}` }], false);
        expect(out!.id).toBeNull();
        expect(out!.error).toMatch(/Unknown scope/);
        expect(out!.reason).toBe('unknown_scope');
    });

    it('rule 7: a team not on the daemon\'s realm list is refused and gets no slot', async () => {
        const d = await new_daemon();
        const listed = team('listed');
        const [ok, refused] = await TeamService.register_from_daemon(
            d, [listed, team('unlisted')], true, new Set([`${scope_slug}/listed`]),
        );
        expect(ok!.id).toBe(listed.id);
        expect(refused).toMatchObject({ slug: 'unlisted', id: null, reason: 'not_in_realm' });
        expect(await slot(d, 'unlisted')).toBeNull();
    });

    it('sync (teams/get on a daemon) uses the same rule and uninstalls what the daemon dropped', async () => {
        const d = await new_daemon();
        const t = team('qa');
        await TeamService.register_from_daemon(d, [t], false);
        const local = randomUUID();
        const run_id = await RunService.create(workspace_id, local, { daemon_id: d });

        await DaemonTeamCacheService.sync(d, [{ ...team('qa', local), description: null }]);
        expect((await slot(d, 'qa'))!.id).toBe(t.id);
        expect((await Run.findByPk(run_id))!.get('team_id')).toBe(t.id);

        await DaemonTeamCacheService.sync(d, []);
        expect((await slot(d, 'qa'))!.get('uninstalled_at')).not.toBeNull();
    });

    it('TeamService.remove marks the slot uninstalled and keeps its runs', async () => {
        const d = await new_daemon();
        const t = team(`solo-${uid()}`);
        await TeamService.register_from_daemon(d, [t], false);
        const run_id = await RunService.create(workspace_id, t.id, { daemon_id: d });
        const row = (await slot(d, t.slug))!;
        await TeamService.remove(row.scope_id, t.slug);
        expect((await slot(d, t.slug))!.get('uninstalled_at')).not.toBeNull();
        expect(await Run.findByPk(run_id)).not.toBeNull();
    });
});
