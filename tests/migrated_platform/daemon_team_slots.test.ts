/**
 * Daemon team rows (PLAN-team-bundle S4.2): a child of a realm team, one per (daemon, catalog team) for life.
 * Core writes a row only when the hub installs a realm team on a daemon, with a fresh id it sends the daemon; a
 * daemon reports teams by that id, and Core never takes an id from a daemon. Uninstall keeps the row (runs keep
 * their team) and a reinstall gets the same id back; when its realm team goes, the row is uninstalled.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { RunService } from '../../src/services/run.service.js';
import { ScopeService } from '../../src/services/control_scope_service.js';
import { TeamService } from '../../src/services/teams_install_service.js';
import { WorkspaceService } from '../../src/services/workspace.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { RealmTeamListService } from '../../src/services/realm_team_list.service.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { publish_version } from './helpers/version_files.js';
import { Daemon, DaemonTeam, Realm, RealmMember, Run, Scope, Team, TeamVersion, Workspace } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const user_id = hub_legacy_uuid(1);

let scope_slug: string;
let scope_id: string;
let workspace_id: string;
let realm_id: string;
const daemons: string[] = [];
const team_ids: string[] = [];

async function new_daemon(in_realm = true): Promise<string> {
    const id = randomUUID();
    await Daemon.create({
        id, api_key_hash: 'slot-test', user_id, user_email: 'platform@test.local',
        hostname: 'slot-test', ip: null, port: null, public_url: null, status: 'online',
        last_heartbeat: Date.now(), capacity: 5, created_at: Date.now(), last_registered_at: Date.now(),
    });
    daemons.push(id);
    if (in_realm) await RealmService.upsert_daemon_member(realm_id, id);
    return id;
}

/** A published catalog team on the realm's list: its id and its versions' ids. */
async function realm_team(name = `t-${uid()}`, versions = ['1.0.0']): Promise<{ team_id: string; name: string; v: Record<string, string> }> {
    const team_id = (await Team.create({
        id: randomUUID(), name, scope: scope_slug, description: name,
        author_id: user_id, license: 'MIT', visibility: 'public', listed: 1, install_count: 0,
    } as never)).id as string;
    team_ids.push(team_id);
    const v: Record<string, string> = {};
    for (const version of versions) v[version] = await publish_version(team_id, version, { name: `@${scope_slug}/${name}`, phases: [] });
    await RealmTeamListService.add(realm_id, user_id, { team_id, version_id: v[versions[0]] });
    return { team_id, name, v };
}

/** What the hub does when it installs a realm team on a daemon: write (or reuse) its row. */
async function hub_install(daemon_id: string, t: { team_id: string; name: string }): Promise<string> {
    const rt = (await RealmTeamListService.find(realm_id, t.team_id))!;
    return (await TeamService.install_slot({ daemon_id, realm_team: rt, scope_id, slug: t.name, description: null, manifest: '{"phases":[]}' })).id;
}

/** The daemon's realm teams, as register_teams passes them. */
const realm_teams = async () => new Map((await RealmTeamListService.entries(realm_id)).map((e) => [e.team_id, e]));
/** What a daemon reports: the id the hub gave it. */
const report = (id: string | null, name: string, version = '1.0.0') => ({ id, scope: scope_slug, slug: name, version, manifest: '{"phases":[]}' });
const row = (id: string) => DaemonTeam.unscoped().findByPk(id, { raw: true }) as Promise<any>;

async function run_label(run_id: string, workspace: string): Promise<string | null> {
    const { runs } = await RunService.list_recent(50, undefined, { workspace_id: workspace, site_admin: true });
    return (runs.find((r: { run_id: string }) => r.run_id === run_id) as { team_label?: string | null } | undefined)?.team_label ?? null;
}

beforeAll(async () => {
    if (!has_postgres) return;
    process.env.CLIQ_BFF_LOG_LEVEL = 'error';
    await open_test_control_plane_store();
    const realm = await RealmService.create(user_id, `slots-${uid()}`.slice(0, 40), 'Slots');
    realm_id = realm.id;
    // The scope belongs to the realm's org (a scope with no org trips the visibility migration).
    scope_slug = `slots-${uid()}`;
    await ScopeService.add(scope_slug, 'Slots', String((await Realm.findByPk(realm_id, { raw: true }) as any).org_id));
    scope_id = String((await Scope.findOne({ where: { slug: scope_slug }, raw: true }) as any).id);
    for (const e of await RealmTeamListService.entries(realm_id)) await RealmTeamListService.remove(realm_id, user_id, e.team_id);
    const { record } = await WorkspaceService.upsert_by_path(`/tmp/slot-test-ws-${uid()}`);
    workspace_id = record.id;
});

afterAll(async () => {
    if (!has_postgres) return;
    await Run.destroy({ where: { workspace_id } });
    await RealmMember.destroy({ where: { realm_id } });
    await Realm.destroy({ where: { id: realm_id } });
    await DaemonTeam.unscoped().destroy({ where: { daemon_id: daemons } });
    await Daemon.destroy({ where: { id: daemons } });
    await TeamVersion.destroy({ where: { team_id: team_ids } });
    await Team.destroy({ where: { id: team_ids } });
    await Scope.destroy({ where: { slug: scope_slug } });
    await close_test_control_plane_store();
});

describe.skipIf(!has_postgres)('daemon team rows: children of realm teams', () => {
    it('the hub installing a realm team writes the row: a fresh id, its catalog team, realm team and version', async () => {
        const d = await new_daemon();
        const t = await realm_team();
        const id = await hub_install(d, t);
        const rt = (await RealmTeamListService.find(realm_id, t.team_id))!;
        expect(await row(id)).toMatchObject({ daemon_id: d, team_id: t.team_id, realm_team_id: rt.id, version_id: t.v['1.0.0'], version: '1.0.0', uninstalled_at: null });
    });

    it('the realm moving to another version keeps the row and its id; the version follows', async () => {
        const d = await new_daemon();
        const t = await realm_team(undefined, ['1.0.0', '1.1.0']);
        const id = await hub_install(d, t);
        await RealmTeamListService.add(realm_id, user_id, { team_id: t.team_id, version_id: t.v['1.1.0'] });
        expect(await hub_install(d, t)).toBe(id);
        expect(await row(id)).toMatchObject({ version_id: t.v['1.1.0'], version: '1.1.0' });
        expect(await DaemonTeam.unscoped().count({ where: { daemon_id: d, team_id: t.team_id } })).toBe(1);
    });

    it("a run records the version its daemon has installed (not the latest); an older run keeps its own (S4.3)", async () => {
        const d = await new_daemon();
        const t = await realm_team(undefined, ['1.0.0', '1.1.0']);
        const id = await hub_install(d, t);
        const first = await RunService.create(workspace_id, id, { daemon_id: d });
        expect(await RunService.load_team_version_id(first)).toBe(t.v['1.0.0']);

        await RealmTeamListService.add(realm_id, user_id, { team_id: t.team_id, version_id: t.v['1.1.0'] });
        await hub_install(d, t);
        const second = await RunService.create(workspace_id, id, { daemon_id: d });
        expect(await RunService.load_team_version_id(second)).toBe(t.v['1.1.0']);
        expect(await RunService.load_team_version_id(first)).toBe(t.v['1.0.0']);
    });

    it("a run keeps its team's @scope/slug from when it was created, even after the install's row goes (S4.3)", async () => {
        const d = await new_daemon();
        const t = await realm_team();
        const id = await hub_install(d, t);
        const run_id = await RunService.create(workspace_id, id, { daemon_id: d });
        expect((await Run.findByPk(run_id, { raw: true }) as any).team_label).toBe(`@${scope_slug}/${t.name}`);

        await DaemonTeam.unscoped().destroy({ where: { id } });
        const { runs } = await RunService.list_recent(50, undefined, { workspace_id, site_admin: true });
        expect(runs.find((r: { run_id: string }) => r.run_id === run_id)?.team_label).toBe(`@${scope_slug}/${t.name}`);
    });

    it('fail_if_live fails a live run with the reason, and never one that already ended (S5.7, P17)', async () => {
        const d = await new_daemon();
        const t = await realm_team();
        const id = await hub_install(d, t);
        const live = await RunService.create(workspace_id, id, { daemon_id: d });
        const ended = await RunService.create(workspace_id, id, { daemon_id: d });
        await RunService.complete(ended, 'completed');

        expect(await RunService.fail_if_live(live, "The daemon didn't start this run: manifest_yaml: Required")).toBe(true);
        expect(await Run.findByPk(live, { raw: true })).toMatchObject({ state: 'failed', error: "The daemon didn't start this run: manifest_yaml: Required" });
        expect(await RunService.fail_if_live(ended, 'late')).toBe(false);
        expect(await Run.findByPk(ended, { raw: true })).toMatchObject({ state: 'completed', error: null });
    });

    it('two daemons, same team: two rows', async () => {
        const [d1, d2] = [await new_daemon(), await new_daemon()];
        const t = await realm_team();
        expect(await hub_install(d1, t)).not.toBe(await hub_install(d2, t));
    });

    it('register_teams keeps a team by the id the hub gave; the version it reports is recorded', async () => {
        const d = await new_daemon();
        const t = await realm_team(undefined, ['1.0.0', '1.1.0']);
        const id = await hub_install(d, t);
        const [out] = await TeamService.register_from_daemon(d, [report(id, t.name, '1.1.0')], false, await realm_teams());
        expect(out).toEqual({ scope: scope_slug, slug: t.name, id });
        expect(await row(id)).toMatchObject({ version: '1.1.0', version_id: t.v['1.1.0'], uninstalled_at: null });
    });

    it("register_teams never takes a daemon's id: an id the hub didn't give this daemon is unknown, no row is made", async () => {
        const [d, other] = [await new_daemon(), await new_daemon()];
        const t = await realm_team();
        const others = await hub_install(other, t);
        const local = randomUUID();
        const out = await TeamService.register_from_daemon(d, [report(local, t.name), report(others, t.name), report(null, t.name)], false, await realm_teams());
        expect(out.map((o) => [o.id, o.reason])).toEqual([[null, 'unknown'], [null, 'unknown'], [null, 'unknown']]);
        expect(await row(local)).toBeNull();
        expect(await DaemonTeam.unscoped().count({ where: { daemon_id: d } })).toBe(0);
    });

    it('register_teams: a team no longer on the realm is not_in_realm and its row is uninstalled', async () => {
        const d = await new_daemon();
        const t = await realm_team();
        const id = await hub_install(d, t);
        const without = await realm_teams();
        without.delete(t.team_id);
        const [out] = await TeamService.register_from_daemon(d, [report(id, t.name)], false, without);
        expect(out).toMatchObject({ id: null, reason: 'not_in_realm' });
        expect((await row(id)).uninstalled_at).not.toBeNull();
    });

    it('uninstall keeps the row (runs keep their team); the hub installing again gets the same id back', async () => {
        const d = await new_daemon();
        const t = await realm_team();
        const id = await hub_install(d, t);
        const run_id = await RunService.create(workspace_id, id, { daemon_id: d });
        // The daemon's whole roster no longer has it → uninstalled, not deleted.
        await TeamService.register_from_daemon(d, [], true, await realm_teams());
        expect((await row(id)).uninstalled_at).not.toBeNull();
        expect(await DaemonTeam.findOne({ where: { daemon_id: d, team_id: t.team_id } })).toBeNull();
        expect(await run_label(run_id, workspace_id)).toBe(`@${scope_slug}/${t.name}`);

        expect(await hub_install(d, t)).toBe(id);
        expect((await row(id)).uninstalled_at).toBeNull();
    });

    it('the realm team going (removed from the realm) uninstalls the row and clears its realm team', async () => {
        const d = await new_daemon();
        const t = await realm_team();
        const id = await hub_install(d, t);
        await RealmTeamListService.remove(realm_id, user_id, t.team_id);
        expect(await row(id)).toMatchObject({ realm_team_id: null, team_id: t.team_id });
        expect((await row(id)).uninstalled_at).not.toBeNull();
        // Added back: a new realm team, the same row.
        await RealmTeamListService.add(realm_id, user_id, { team_id: t.team_id });
        expect(await hub_install(d, t)).toBe(id);
    });

    it('TeamService.remove marks the row uninstalled and keeps its runs', async () => {
        const d = await new_daemon();
        const t = await realm_team();
        const id = await hub_install(d, t);
        const run_id = await RunService.create(workspace_id, id, { daemon_id: d });
        await TeamService.remove(scope_id, t.name);
        expect((await row(id)).uninstalled_at).not.toBeNull();
        expect(await Run.findByPk(run_id)).not.toBeNull();
    });

    it('runs/get { team_id } (the catalog team) lists runs of every install of it, uninstalled ones included; a daemon team id its own (S4.3)', async () => {
        const [d1, d2] = [await new_daemon(), await new_daemon()];
        const t = await realm_team();
        const other = await realm_team();
        const a = await hub_install(d1, t);
        const b = await hub_install(d2, t);
        const o = await hub_install(d1, other);
        const r1 = await RunService.create(workspace_id, a, { daemon_id: d1 });
        const r2 = await RunService.create(workspace_id, b, { daemon_id: d2 });
        const r3 = await RunService.create(workspace_id, o, { daemon_id: d1 });
        await TeamService.register_from_daemon(d2, [], true, await realm_teams()); // d2's install uninstalled

        const { runs, total } = await RunService.list_recent(50, undefined, { team_id: t.team_id, site_admin: true });
        expect(runs.map((r: { run_id: string }) => r.run_id).sort()).toEqual([r1, r2].sort());
        expect(total).toBe(2);
        expect(runs.some((r: { run_id: string }) => r.run_id === r3)).toBe(false);

        const own = await RunService.list_recent(50, undefined, { team_id: b, site_admin: true });
        expect(own.runs.map((r: { run_id: string }) => r.run_id)).toEqual([r2]);

        const none = await RunService.list_recent(50, undefined, { team_id: randomUUID(), site_admin: true });
        expect(none.total).toBe(0);
    });

    it('deleting a workspace keeps its runs (marked deleted, hidden); registering the path again brings it back', async () => {
        const d = await new_daemon();
        const t = await realm_team();
        const id = await hub_install(d, t);
        const path = `/tmp/ws-delete-${uid()}`;
        const { record } = await WorkspaceService.upsert_by_path(path, 'del', d);
        const run_id = await RunService.create(String(record.id), id, { daemon_id: d });

        expect(await WorkspaceService.remove(String(record.id))).toBe(true);
        expect(await Run.findByPk(run_id)).not.toBeNull();
        expect(await Workspace.findByPk(String(record.id))).toBeNull();
        expect((await Workspace.unscoped().findByPk(String(record.id)))?.get('deleted_at')).not.toBeNull();
        const { runs } = await RunService.list_recent(50, undefined, { workspace_id: String(record.id), site_admin: true });
        expect((runs[0] as { workspace_name?: string } | undefined)?.workspace_name).toBe('del');

        const again = await WorkspaceService.upsert_by_path(path, null, d);
        expect(String(again.record.id)).toBe(String(record.id));
        expect(await Workspace.findByPk(String(record.id))).not.toBeNull();
        await Run.destroy({ where: { workspace_id: String(record.id) } });
        await Workspace.unscoped().destroy({ where: { id: String(record.id) } });
    });
});
