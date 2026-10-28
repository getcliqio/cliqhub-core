/**
 * PLAN-realm-team-versions — the realm owns each team's version, on a real Postgres (skipped without one).
 *
 *  - Adding a team records a version: the latest published (by semver) unless one is asked for; asking for
 *    another moves the realm to it; an unknown version or an unpublished team is refused.
 *  - Every install the realm sends (force sync, a daemon connecting) asks for the realm's version.
 *  - The realm's team list shows the realm's version, and how many daemons online now aren't on it
 *    (offline daemons don't count).
 *  - The one-time migration versions existing entries and drops entries no daemon could install.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { Daemon, DaemonTeam, Realm, RealmMember, Scope, Setting, Team, TeamVersion } from '../../src/models/index.js';
import { RealmService } from '../../src/services/realm.service.js';
import { RealmTeamListService } from '../../src/services/realm_team_list.service.js';
import { DispatchService } from '../../src/services/dispatch.service.js';
import * as outbox from '../../src/services/command_outbox.service.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { REALM_TEAM_LIST_VERSIONS_MIGRATION_KEY, migrate_realm_team_list_versions } from '../../src/models/migrations/control_plane_schema_migrations.js';

const has_postgres = await postgres_reachable();
const uid = () => `rtv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('the realm owns each team\'s version', () => {
    const user_id = hub_legacy_uuid(1);
    const scope_slug = uid().slice(0, 40);
    let scope_id: string;
    const team_ids: string[] = [];
    const realm_ids: string[] = [];
    const daemon_ids: string[] = [];
    let realm_id: string;
    let d_on_old: string;   // online, alpha 1.9.0
    let d_on_none: string;  // online, no alpha
    let d_off_old: string;  // offline, alpha 1.9.0

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
        vi.spyOn(outbox, 'command_outbox_enqueue').mockResolvedValue({ tx_id: 'tx' } as never);

        scope_id = randomUUID();
        await Scope.create({
            id: scope_id, slug: scope_slug, display_name: 'Versions', owner_id: null, org_id: null,
            is_default: 0, created_at: new Date(),
        });
        const publish = async (name: string, versions: string[]) => {
            const team = await Team.create({
                id: randomUUID(), name, scope: scope_slug, description: name,
                author_id: user_id, license: 'MIT', visibility: 'public', listed: 1, install_count: 0,
            } as never);
            team_ids.push(team.id);
            for (const version of versions) {
                await TeamVersion.create({
                    id: randomUUID(), team_id: team.id, version, changelog: '', package_path: `/tmp/${name}-${version}.zip`,
                    workflow_json: JSON.stringify({ phases: [] }), manifest_yaml: '', readme: '',
                    capability_json: '{}', agents_json: '{}', roles_json: '[]', tools: '[]', published_at: new Date(),
                } as never);
            }
        };
        // 1.10.0 is newer than 1.9.0 (semver, not text order).
        await publish('alpha', ['1.9.0', '1.10.0']);
        await publish('beta', ['2.0.0']);

        realm_id = (await RealmService.create(user_id, uid().slice(0, 40), 'Versions realm')).id;
        realm_ids.push(realm_id);
        await Realm.update({ team_list: [] } as never, { where: { id: realm_id } });

        const daemon = async (status: 'online' | 'offline', alpha_version: string | null) => {
            const id = uid();
            daemon_ids.push(id);
            await Daemon.create({
                id, api_key_hash: 'h', user_id: null, user_email: null, hostname: 'pod', ip: '127.0.0.1',
                port: 4900, public_url: `https://daemon.test/${id}`, status,
                last_heartbeat: Date.now(), capacity: 5, created_at: Date.now(), last_registered_at: Date.now(),
            } as never);
            await RealmService.upsert_daemon_member(realm_id, id);
            if (alpha_version) {
                await DaemonTeam.create({
                    id: randomUUID(), daemon_id: id, scope_id, slug: 'alpha', version: alpha_version, description: null,
                    manifest: 'name: alpha\n', dockerfile: null, dependencies: null, created_at: Date.now(), updated_at: Date.now(),
                } as never);
            }
            return id;
        };
        d_on_old = await daemon('online', '1.9.0');
        d_on_none = await daemon('online', null);
        d_off_old = await daemon('offline', '1.9.0');
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        await DaemonTeam.destroy({ where: { scope_id } });
        await RealmMember.destroy({ where: { realm_id: realm_ids } });
        await Realm.destroy({ where: { id: realm_ids } });
        await Daemon.destroy({ where: { id: daemon_ids } });
        await TeamVersion.destroy({ where: { team_id: team_ids } });
        await Team.destroy({ where: { id: team_ids } });
        await Scope.destroy({ where: { id: scope_id } });
        await close_test_control_plane_store();
    });

    const alpha = () => ({ scope: scope_slug, slug: 'alpha' });

    it('adding a team records the latest published version; asking for another moves the realm to it', async () => {
        let list = await RealmTeamListService.add(realm_id, user_id, alpha());
        expect(list).toEqual([{ ...alpha(), version: '1.10.0' }]);
        list = await RealmTeamListService.add(realm_id, user_id, { ...alpha(), version: '1.9.0' });
        expect(list).toEqual([{ ...alpha(), version: '1.9.0' }]);
        // Added again without a version (the builder's "update realms"): moves to the latest.
        list = await RealmTeamListService.add(realm_id, user_id, alpha());
        expect(list).toEqual([{ ...alpha(), version: '1.10.0' }]);
    });

    it('an unknown version, or a team that was never published, is refused', async () => {
        await expect(RealmTeamListService.add(realm_id, user_id, { ...alpha(), version: '3.0.0' })).rejects.toMatchObject({ status_code: 404 });
        await expect(RealmTeamListService.add(realm_id, user_id, { scope: scope_slug, slug: 'never-published' })).rejects.toMatchObject({ status_code: 404 });
    });

    it('the list shows the realm\'s version, and the online daemons not on it (offline ones not counted)', async () => {
        await RealmTeamListService.add(realm_id, user_id, { ...alpha(), version: '1.10.0' });
        const { rows } = await RealmService.list_team_coverage({ realm_id }, user_id);
        const row = rows.find((r) => r.slug === 'alpha')!;
        expect(row.version).toBe('1.10.0');
        // d_on_old (1.9.0) and d_on_none (not installed) are online and not on 1.10.0; d_off_old is offline.
        expect(row.online_stale).toBe(2);
        expect(row.current_daemon_ids).toEqual([]);

        await RealmTeamListService.add(realm_id, user_id, { ...alpha(), version: '1.9.0' });
        const again = (await RealmService.list_team_coverage({ realm_id }, user_id)).rows.find((r) => r.slug === 'alpha')!;
        expect(again).toMatchObject({ version: '1.9.0', online_stale: 1 });
        // On the realm's version, online or not.
        expect([...again.current_daemon_ids].sort()).toEqual([d_on_old, d_off_old].sort());
    });

    it('every install the realm sends asks for the realm\'s version', async () => {
        await RealmTeamListService.add(realm_id, user_id, { ...alpha(), version: '1.9.0' });
        const install = vi.spyOn(DispatchService, 'install_team').mockResolvedValue({ team_id: 'x', results: [] } as never);
        await RealmTeamListService.sync_team(realm_id, user_id, alpha());
        await RealmTeamListService.inject_for_daemon(realm_id, d_on_none, user_id);
        expect(install.mock.calls.map((c) => c[0].version)).toEqual(['1.9.0', '1.9.0']);
        install.mockRestore();
    });

    it('migration: existing entries get a version (a valid one is kept); entries no daemon could install are dropped; once', async () => {
        const other = (await RealmService.create(user_id, uid().slice(0, 40), 'Migrated realm')).id;
        realm_ids.push(other);
        await Realm.update({ team_list: [
            { scope: scope_slug, slug: 'alpha' },
            { scope: scope_slug, slug: 'beta', version: '2.0.0' },
            { scope: scope_slug, slug: 'gone' },
        ] } as never, { where: { id: other } });

        await Setting.destroy({ where: { key: REALM_TEAM_LIST_VERSIONS_MIGRATION_KEY } });
        await migrate_realm_team_list_versions(get_sequelize());
        const list = (await Realm.findByPk(other, { raw: true }))!.team_list;
        expect(list).toEqual([
            { scope: scope_slug, slug: 'alpha', version: '1.10.0' },
            { scope: scope_slug, slug: 'beta', version: '2.0.0' },
        ]);

        // Once: a later change is left alone.
        await Realm.update({ team_list: [{ scope: scope_slug, slug: 'gone' }] } as never, { where: { id: other } });
        await migrate_realm_team_list_versions(get_sequelize());
        expect((await Realm.findByPk(other, { raw: true }))!.team_list).toEqual([{ scope: scope_slug, slug: 'gone' }]);
        expect(await Setting.findByPk(REALM_TEAM_LIST_VERSIONS_MIGRATION_KEY)).toBeTruthy();
    });
});
