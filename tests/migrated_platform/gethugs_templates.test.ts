/**
 * PLAN-gethugs-step8-4-cliqd.md part 2 (decision 10): team hugs as getHugs templates, against a fake getHugs.
 * Installed teams' `hugs/<name>.hug` → templates `@scope/slug/<hug>`; every installed version's bundle is a version,
 * the newest installed one current; a template no installed version carries, of a team with no open run, is archived
 * and restored when wanted again; templates Core didn't make are left alone; a team install, removal or version
 * change marks the org.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hug_bundle_hash, to_hug_file } from '@getcliqio/cliq-sdk';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { publish_version } from './helpers/version_files.js';
import { FakeGethugs } from '../helpers/fake_gethugs.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { Org, OrgMember, OrgRole, Run, Team, User } from '../../src/models/index.js';
import { seed_default_roles_for_org } from '../../src/models/migrations/migrate_org_roles.js';
import { GethugsPartner } from '../../src/services/gethugs.service.js';
import { reconcile_templates } from '../../src/services/gethugs_templates.js';
import { RealmService } from '../../src/services/realm.service.js';
import { RealmTeamListService } from '../../src/services/realm_team_list.service.js';
import { WorkspaceService } from '../../src/services/workspace.service.js';

const has_postgres = await postgres_reachable();
const uid = () => `gt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A hug's bundle files that pass getHugs' rules; `tag` changes its content (a new version). */
const hug_files = (name: string, tag = '') => ({
    'hug.json': JSON.stringify({ name, title: `Hug ${name}`, description: 'Asks', sdk_version: '1.2.0', definition: 'definition.mjs' }),
    'index.html': `<!doctype html><script type="module" src="./main.js"></script><!-- ${tag} -->`,
    'main.js': 'console.log(1)',
    'definition.mjs': 'export default {}',
});

describe.skipIf(!has_postgres)('team hugs as getHugs templates', () => {
    let fake: FakeGethugs;
    let partner: GethugsPartner;
    let owner: string;
    let org_id: string;
    let realm_a: string;
    let realm_b: string;
    const G_ORG = 'org_fake';
    const cleanup: { orgs: string[]; teams: string[] } = { orgs: [], teams: [] };

    async function sync(): Promise<string[]> {
        const writes: string[] = [];
        await reconcile_templates({
            org_id, g_org: G_ORG,
            call: (path, body, cliq_ref) => { writes.push(`${path} ${cliq_ref}`); return partner.site.call(path, body); },
            read: (path, body) => partner.site.call(path, body),
            attempt: async (_k, _id, fn) => fn(),
        });
        return writes;
    }
    const templates = () => fake.templates.filter((t) => !t.builtin);
    const by_name = (name: string) => templates().find((t) => t.name === name);

    /** A catalog team whose versions carry the given hugs (name → tag). */
    async function team() {
        const name = `t-${uid()}`.slice(0, 30);
        const row = await Team.create({ id: randomUUID(), name, scope: 'acme', description: 't', author_id: owner, license: 'MIT', visibility: 'public', listed: 1, install_count: 0 } as never);
        cleanup.teams.push(row.id);
        const publish = (version: string, hugs: Record<string, string>) => publish_version(row.id, version, { name: `@acme/${name}`, phases: [] },
            Object.fromEntries(Object.entries(hugs).map(([h, tag]) => [`hugs/${h}.hug`, to_hug_file(hug_files(h, tag))])));
        return { id: row.id, label: `@acme/${name}`, publish };
    }
    async function open_run(team_id: string): Promise<string> {
        const { record: ws } = await WorkspaceService.upsert_by_path(`/tmp/${uid()}`);
        const run_id = uid();
        await Run.create({ run_id, workspace_id: ws.id, team_id, state: 'running', started_at: Date.now(), realm_id: realm_a, org_id } as never);
        return run_id;
    }
    async function marked_at(): Promise<number> {
        const [r] = await get_sequelize().query('SELECT marked_at FROM cliq.gethugs_sync WHERE org_id = :org_id', { replacements: { org_id } }) as [Array<{ marked_at: Date }>, unknown];
        return r[0] ? r[0].marked_at.getTime() : 0;
    }

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
    });
    beforeEach(async () => {
        fake = new FakeGethugs();
        partner = new GethugsPartner({ url: 'http://gethugs.test', token: 'hugs_svc_test', app_url: 'http://app.gethugs.test' }, fake.fetch);
        owner = randomUUID();
        const name = uid();
        await User.create({ id: owner, username: name, email: `${name}@cliq.test`, display_name: name, status: 'active', role: 'user', password_hash: 'x' } as never);
        const org = await Org.create({ slug: uid(), display_name: 'Templates', status: 'active', owner_id: owner, activated_at: new Date() } as never);
        org_id = org.id;
        cleanup.orgs.push(org_id);
        await seed_default_roles_for_org(org_id);
        const role = await OrgRole.findOne({ where: { org_id, slug: 'owner' }, attributes: ['id'], raw: true });
        await OrgMember.create({ org_id, user_id: owner, role: 'admin', role_id: role!.id, status: 'active', joined_at: new Date() } as never);
        realm_a = (await RealmService.create(owner, 'default', 'Main', { org_id })).id;
        realm_b = (await RealmService.create(owner, uid(), 'Ops', { org_id })).id;
    });
    afterAll(async () => {
        const sq = get_sequelize();
        if (cleanup.orgs.length) {
            const ids = { replacements: { ids: cleanup.orgs } };
            await sq.query('DELETE FROM cliq.realm_teams WHERE realm_id IN (SELECT id FROM cliq.realms WHERE org_id = ANY(ARRAY[:ids]::uuid[]))', ids);
            await sq.query('DELETE FROM cliq.team_runs WHERE org_id::text = ANY(ARRAY[:ids]::text[])', ids);
            await sq.query('DELETE FROM cliq.realm_members WHERE realm_id IN (SELECT id FROM cliq.realms WHERE org_id = ANY(ARRAY[:ids]::uuid[]))', ids);
            await sq.query('DELETE FROM cliq.realms WHERE org_id = ANY(ARRAY[:ids]::uuid[])', ids);
            await Org.destroy({ where: { id: cleanup.orgs } });
        }
        await close_test_control_plane_store();
    });

    it('an installed team hug is a template @scope/slug/<hug> with that bundle current; a second sync writes nothing', async () => {
        const t = await team();
        const v1 = await t.publish('1.0.0', { review: 'a' });
        await RealmTeamListService.add(realm_a, owner, { team_id: t.id, version_id: v1 });
        expect(await sync()).toEqual([`templates/create template:${t.label}/review`]);
        const tpl = by_name(`${t.label}/review`)!;
        expect(tpl.versions).toHaveLength(1);
        expect(tpl.current).toBe(tpl.versions[0]!.id);
        const [rows] = await get_sequelize().query('SELECT sha256, template_id, version_id FROM cliq.gethugs_templates WHERE org_id = :org_id', { replacements: { org_id } });
        expect(rows).toEqual([{ sha256: hug_bundle_hash(hug_files('review', 'a')), template_id: tpl.id, version_id: tpl.versions[0]!.id }]);
        expect(await sync()).toEqual([]);
    });

    it('every installed version is a version; the newest installed one is current, whichever realm installed it', async () => {
        const t = await team();
        const v1 = await t.publish('1.0.0', { review: 'a' });
        const v2 = await t.publish('2.0.0', { review: 'b' });
        await RealmTeamListService.add(realm_a, owner, { team_id: t.id, version_id: v2 });
        await RealmTeamListService.add(realm_b, owner, { team_id: t.id, version_id: v1 });
        await sync();
        const tpl = by_name(`${t.label}/review`)!;
        expect(tpl.versions).toHaveLength(2);
        expect(tpl.versions.find((v) => v.id === tpl.current)!.files).toEqual(hug_files('review', 'b'));
        // Realm B moves to 2.0.0 and A stays: nothing new; the old version stays a version (past Hugs, open runs).
        await RealmTeamListService.add(realm_b, owner, { team_id: t.id, version_id: v2 });
        expect(await sync()).toEqual([]);
    });

    it('a new team version that changes the hug adds a version and makes it current — not current at add time', async () => {
        const t = await team();
        const v1 = await t.publish('1.0.0', { review: 'a' });
        await RealmTeamListService.add(realm_a, owner, { team_id: t.id, version_id: v1 });
        await sync();
        const v2 = await t.publish('1.1.0', { review: 'b' });
        await RealmTeamListService.add(realm_a, owner, { team_id: t.id, version_id: v2 });
        const writes = await sync();
        expect(writes).toEqual([`templates/add_version template:${t.label}/review`, `templates/update template:${t.label}/review`]);
        const tpl = by_name(`${t.label}/review`)!;
        expect(tpl.versions.find((v) => v.id === tpl.current)!.files).toEqual(hug_files('review', 'b'));
    });

    it('a team taken off every realm: kept while it has an open run, archived after; installed again, restored', async () => {
        const t = await team();
        const v1 = await t.publish('1.0.0', { review: 'a' });
        await RealmTeamListService.add(realm_a, owner, { team_id: t.id, version_id: v1 });
        await sync();
        await RealmTeamListService.remove(realm_a, owner, t.id);
        const run_id = await open_run(t.id);
        expect(await sync()).toEqual([]);
        expect(by_name(`${t.label}/review`)!.archived_at).toBeNull();
        await Run.update({ state: 'completed' } as never, { where: { run_id } });
        expect(await sync()).toEqual([`templates/delete template:${t.label}/review`]);
        expect(by_name(`${t.label}/review`)!.archived_at).not.toBeNull();
        await RealmTeamListService.add(realm_a, owner, { team_id: t.id, version_id: v1 });
        expect(await sync()).toEqual([`templates/update template:${t.label}/review`]);
        expect(by_name(`${t.label}/review`)!.archived_at).toBeNull();
        expect(templates().filter((x) => x.name === `${t.label}/review`)).toHaveLength(1);
    });

    it('a hug renamed in a new version is a new template; the old one is archived (no open run)', async () => {
        const t = await team();
        const v1 = await t.publish('1.0.0', { review: 'a' });
        await RealmTeamListService.add(realm_a, owner, { team_id: t.id, version_id: v1 });
        await sync();
        const v2 = await t.publish('2.0.0', { approve: 'a' });
        await RealmTeamListService.add(realm_a, owner, { team_id: t.id, version_id: v2 });
        expect((await sync()).sort()).toEqual([`templates/create template:${t.label}/approve`, `templates/delete template:${t.label}/review`].sort());
    });

    it('templates Core didn\'t make are left alone', async () => {
        await partner.site.call('templates/create', { org_id: G_ORG, name: '@acme/someone-else/thing', files: hug_files('thing') });
        expect(await sync()).toEqual([]);
        expect(by_name('@acme/someone-else/thing')!.archived_at).toBeNull();
    });

    it('a team install, version change and removal mark the org', async () => {
        const t = await team();
        const v1 = await t.publish('1.0.0', { review: 'a' });
        const v2 = await t.publish('1.0.1', { review: 'a' });
        let before = await marked_at();
        await RealmTeamListService.add(realm_a, owner, { team_id: t.id, version_id: v1 });
        expect(await marked_at()).toBeGreaterThan(before);
        before = await marked_at();
        await RealmTeamListService.add(realm_a, owner, { team_id: t.id, version_id: v2 });
        expect(await marked_at()).toBeGreaterThan(before);
        before = await marked_at();
        await RealmTeamListService.remove(realm_a, owner, t.id);
        expect(await marked_at()).toBeGreaterThan(before);
    });
});
