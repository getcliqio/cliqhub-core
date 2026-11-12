/**
 * Daemon team rows (PLAN-team-bundle S4.2): a child of a realm team, one per (daemon, catalog team) for life.
 * Core writes a row only when the hub installs a realm team on a daemon, with a fresh id it sends the daemon; a
 * daemon reports teams by that id, and Core never takes an id from a daemon. Uninstall keeps the row (runs keep
 * their team) and a reinstall gets the same id back; when its realm team goes, the row is uninstalled.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { QueryTypes } from 'sequelize';
import { settle_install_command } from '../../src/services/command_outbox.service.js';
import { DispatchService } from '../../src/services/dispatch.service.js';
import { InAppNotificationService } from '../../src/services/in_app_notification.service.js';
import { migrate_realm_team_delivery, REALM_TEAM_DELIVERY_MIGRATION_KEY } from '../../src/models/migrations/control_plane_schema_migrations.js';
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
import { Daemon, DaemonTeam, Realm, RealmMember, RealmTeam, Run, Scope, Team, TeamVersion, Workspace } from '../../src/models/index.js';

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

    describe('delivery (PLAN-realm-team-delivery): a push is pending until the daemon confirms it', () => {
        it("a complete roster never undoes a push in flight — the 2026-11-12 race: slot A pushed, the daemon's empty roster, slot B pushed", async () => {
            const d = await new_daemon();
            const a = await realm_team();
            const b = await realm_team();
            const slot_a = await hub_install(d, a);
            await TeamService.register_from_daemon(d, [], true, await realm_teams());
            const slot_b = await hub_install(d, b);
            expect((await row(slot_a)).uninstalled_at).toBeNull();
            expect((await row(slot_b)).uninstalled_at).toBeNull();
            expect((await row(slot_a)).confirmed_at).toBeNull();
        });

        it('a complete roster still uninstalls a confirmed team the daemon no longer has (a real local uninstall)', async () => {
            const d = await new_daemon();
            const t = await realm_team();
            const id = await hub_install(d, t);
            await TeamService.register_from_daemon(d, [report(id, t.name)], true, await realm_teams());
            expect((await row(id)).confirmed_at).not.toBeNull();
            await TeamService.register_from_daemon(d, [], true, await realm_teams());
            expect((await row(id)).uninstalled_at).not.toBeNull();
        });

        it('pushing again (a re-sync, a new version) makes the slot pending again until the daemon confirms', async () => {
            const d = await new_daemon();
            const t = await realm_team();
            const id = await hub_install(d, t);
            await TeamService.register_from_daemon(d, [report(id, t.name)], true, await realm_teams());
            expect(await hub_install(d, t)).toBe(id);
            expect((await row(id)).confirmed_at).toBeNull();
        });

        /** The `/v1/install` command the hub sent for this push. */
        const install_cmd = (d: string, t: { team_id: string; v: Record<string, string> }, version = '1.0.0') =>
            ({ daemon_id: d, endpoint: '/v1/install', payload: JSON.stringify({ team_id: t.team_id, version_id: t.v[version] }) });

        it("the daemon's ok ack confirms the push", async () => {
            const d = await new_daemon();
            const t = await realm_team();
            const id = await hub_install(d, t);
            await settle_install_command(install_cmd(d, t), { ok: true });
            expect((await row(id)).confirmed_at).not.toBeNull();
            expect((await row(id)).uninstalled_at).toBeNull();
        });

        it("the daemon's error ack uninstalls the push, keeps its reason and tells the realm's owners", async () => {
            const notify = vi.spyOn(InAppNotificationService, 'create_from_payload').mockResolvedValue(undefined as never);
            try {
                const d = await new_daemon();
                const t = await realm_team();
                const id = await hub_install(d, t);
                await settle_install_command(install_cmd(d, t), { ok: false, reason: "Phase 'plan' has role roles/plan.md, which isn't one of the team's files" });
                expect((await row(id)).uninstalled_at).not.toBeNull();
                expect((await row(id)).install_error).toContain('roles/plan.md');
                expect(notify).toHaveBeenCalledWith(expect.objectContaining({
                    event: 'realm.team_list.install_failed', realm_id, daemon_id: d,
                    title: `@${scope_slug}/${t.name} didn't install`, message: expect.stringContaining('roles/plan.md'),
                }));
            } finally {
                notify.mockRestore();
            }
        });

        it('delivery giving up clears the pending push ("never delivered")', async () => {
            const d = await new_daemon();
            const t = await realm_team();
            const id = await hub_install(d, t);
            await settle_install_command(install_cmd(d, t), { ok: false, reason: 'install never delivered: fetch failed' });
            expect((await row(id)).uninstalled_at).not.toBeNull();
            expect((await row(id)).install_error).toBe('install never delivered: fetch failed');
        });

        it("an ack of an older push doesn't settle a newer one; a late error doesn't undo what the roster confirmed", async () => {
            const d = await new_daemon();
            const t = await realm_team(undefined, ['1.0.0', '1.1.0']);
            const id = await hub_install(d, t);
            // The realm moves to 1.1.0 and pushes again: the 1.0.0 command's ack is stale.
            await RealmTeamListService.add(realm_id, user_id, { team_id: t.team_id, version_id: t.v['1.1.0'] }).catch(async () => {
                await RealmTeam.update({ version_id: t.v['1.1.0'], version: '1.1.0' } as never, { where: { realm_id, team_id: t.team_id } });
            });
            await hub_install(d, t);
            await settle_install_command(install_cmd(d, t, '1.0.0'), { ok: true });
            expect((await row(id)).confirmed_at).toBeNull();
            // The roster confirms 1.1.0, then a late error ack arrives for it: the row stays.
            await TeamService.register_from_daemon(d, [report(id, t.name, '1.1.0')], true, await realm_teams());
            await settle_install_command(install_cmd(d, t, '1.1.0'), { ok: false, reason: 'late' });
            expect((await row(id)).uninstalled_at).toBeNull();
        });

        it('runs: only daemons that confirmed the team are eligible; with none, why (pending / failed / on no daemon)', async () => {
            const dispatch = DispatchService as unknown as {
                _daemon_ids_with_team(ref: string, ids: string[]): Promise<string[]>;
                _why_no_daemon_has_team(ref: string, ids: string[], realm_id: string): Promise<string>;
            };
            const d1 = await new_daemon();
            const d2 = await new_daemon();
            const t = await realm_team();
            const id1 = await hub_install(d1, t);
            await hub_install(d2, t);
            expect(await dispatch._daemon_ids_with_team(t.team_id, [d1, d2])).toEqual([]);
            expect(await dispatch._why_no_daemon_has_team(t.team_id, [d1, d2], realm_id)).toMatch(/installed yet — install pending on /);
            await settle_install_command(install_cmd(d1, t), { ok: true });
            expect(await dispatch._daemon_ids_with_team(t.team_id, [d1, d2])).toEqual([d1]);
            expect((await row(id1)).confirmed_at).not.toBeNull();

            const notify = vi.spyOn(InAppNotificationService, 'create_from_payload').mockResolvedValue(undefined as never);
            try {
                const d3 = await new_daemon();
                const u = await realm_team();
                await hub_install(d3, u);
                await settle_install_command(install_cmd(d3, u), { ok: false, reason: 'agent claude-code missing setting api_key' });
                expect(await dispatch._why_no_daemon_has_team(u.team_id, [d3], realm_id))
                    .toMatch(new RegExp(`@${scope_slug}/${u.name} installed — the install failed on .*: agent claude-code missing setting api_key`));
            } finally {
                notify.mockRestore();
            }
            const nowhere = await realm_team();
            expect(await dispatch._why_no_daemon_has_team(nowhere.team_id, [d1], realm_id)).toMatch(/installed on no online daemon/);
        });

        it('the migration confirms what was installed at deploy, once (a later push stays pending)', async () => {
            const d = await new_daemon();
            const t = await realm_team();
            const gone = await realm_team();
            const id = await hub_install(d, t);
            const old = await hub_install(d, gone);
            await DaemonTeam.unscoped().update({ uninstalled_at: Date.now() } as never, { where: { id: old } });
            const sq = DaemonTeam.sequelize!;
            const saved = await sq.query(`SELECT "value" FROM cliq."settings" WHERE "key" = :key`, { replacements: { key: REALM_TEAM_DELIVERY_MIGRATION_KEY }, type: QueryTypes.SELECT }) as Array<{ value: string }>;
            await sq.query(`DELETE FROM cliq."settings" WHERE "key" = :key`, { replacements: { key: REALM_TEAM_DELIVERY_MIGRATION_KEY } });
            try {
                await migrate_realm_team_delivery(sq);
                expect((await row(id)).confirmed_at).not.toBeNull();
                expect((await row(old)).confirmed_at).toBeNull();
                // Keyed: a push after the migration isn't confirmed by running it again.
                const later = await realm_team();
                const pending = await hub_install(d, later);
                await migrate_realm_team_delivery(sq);
                expect((await row(pending)).confirmed_at).toBeNull();
            } finally {
                await sq.query(`DELETE FROM cliq."settings" WHERE "key" = :key`, { replacements: { key: REALM_TEAM_DELIVERY_MIGRATION_KEY } });
                if (saved[0]) {
                    await sq.query(`INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW())`,
                        { replacements: { key: REALM_TEAM_DELIVERY_MIGRATION_KEY, value: saved[0].value } });
                }
            }
        });
    });

    it('uninstall keeps the row (runs keep their team); the hub installing again gets the same id back', async () => {
        const d = await new_daemon();
        const t = await realm_team();
        const id = await hub_install(d, t);
        const run_id = await RunService.create(workspace_id, id, { daemon_id: d });
        // The daemon had it (its roster confirms the push), then its whole roster no longer has it → uninstalled, not
        // deleted. (A pending push isn't undone by a roster: PLAN-realm-team-delivery, tested below.)
        await TeamService.register_from_daemon(d, [report(id, t.name)], true, await realm_teams());
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

    // S8: sub-teams a realm team's tree brings get rows too, tied to that realm team.
    describe('sub-teams from a realm team\'s tree (PLAN-team-bundle S8)', () => {
        /** A published catalog team that is not on the realm. */
        async function catalog_team(name = `sub-${uid()}`): Promise<{ team_id: string; name: string; v: string }> {
            const team_id = (await Team.create({
                id: randomUUID(), name, scope: scope_slug, description: name,
                author_id: user_id, license: 'MIT', visibility: 'public', listed: 1, install_count: 0,
            } as never)).id as string;
            team_ids.push(team_id);
            return { team_id, name, v: await publish_version(team_id, '1.0.0', { name: `@${scope_slug}/${name}`, phases: [] }) };
        }

        it('a sub-team gets a live row tied to the realm team it came with (no realm team of its own); a reinstall keeps it', async () => {
            const d = await new_daemon();
            const parent = await realm_team();
            await hub_install(d, parent);
            const rt = (await RealmTeamListService.find(realm_id, parent.team_id))!;
            const leaf = await catalog_team();
            await TeamService.install_tree_slots(d, rt.id, [{ team_id: leaf.team_id, version_id: leaf.v }]);
            const rows = await DaemonTeam.unscoped().findAll({ where: { daemon_id: d, team_id: leaf.team_id }, raw: true }) as any[];
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ realm_team_id: null, via_realm_team_id: rt.id, version_id: leaf.v, version: '1.0.0', slug: leaf.name, uninstalled_at: null });
            await TeamService.install_tree_slots(d, rt.id, [{ team_id: leaf.team_id, version_id: leaf.v }]);
            expect(await DaemonTeam.unscoped().count({ where: { daemon_id: d, team_id: leaf.team_id } })).toBe(1);
        });

        it('a sub-team that is also on the realm keeps its realm row', async () => {
            const d = await new_daemon();
            const parent = await realm_team();
            const both = await realm_team();
            await hub_install(d, parent);
            const own = await hub_install(d, both);
            const rt = (await RealmTeamListService.find(realm_id, parent.team_id))!;
            await TeamService.install_tree_slots(d, rt.id, [{ team_id: both.team_id, version_id: both.v['1.0.0'] }]);
            expect(await row(own)).toMatchObject({ realm_team_id: (await RealmTeamListService.find(realm_id, both.team_id))!.id, via_realm_team_id: null });
        });

        it('register_teams keeps a sub-team while the realm team it came with is on the realm', async () => {
            const d = await new_daemon();
            const parent = await realm_team();
            const pid = await hub_install(d, parent);
            const rt = (await RealmTeamListService.find(realm_id, parent.team_id))!;
            const leaf = await catalog_team();
            await TeamService.install_tree_slots(d, rt.id, [{ team_id: leaf.team_id, version_id: leaf.v }]);
            const lid = ((await DaemonTeam.findOne({ where: { daemon_id: d, team_id: leaf.team_id }, raw: true })) as any).id;
            const out = await TeamService.register_from_daemon(d, [report(pid, parent.name), report(lid, leaf.name)], true, await realm_teams());
            expect(out.map((o) => o.id)).toEqual([pid, lid]);
            expect(await row(lid)).toMatchObject({ uninstalled_at: null });
        });

        it('the realm team going uninstalls the sub-teams it brought', async () => {
            const d = await new_daemon();
            const parent = await realm_team();
            await hub_install(d, parent);
            const rt = (await RealmTeamListService.find(realm_id, parent.team_id))!;
            const leaf = await catalog_team();
            await TeamService.install_tree_slots(d, rt.id, [{ team_id: leaf.team_id, version_id: leaf.v }]);
            const lid = ((await DaemonTeam.findOne({ where: { daemon_id: d, team_id: leaf.team_id }, raw: true })) as any).id;
            await RealmTeamListService.remove(realm_id, user_id, parent.team_id);
            expect(await row(lid)).toMatchObject({ via_realm_team_id: null, uninstalled_at: expect.anything() });
        });
    });
});

