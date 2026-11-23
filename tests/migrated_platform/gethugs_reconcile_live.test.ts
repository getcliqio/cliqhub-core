/**
 * PLAN-gethugs-step2-provisioning.md sub-step 3, live: a cliq org (test database) reconciled into a real getHugs (the
 * local stack), read back through the partner token, reconciled again with nothing to write, then deleted in cliq
 * and suspended in getHugs. Also a team hug as a template (PLAN-gethugs-step8-4-cliqd.md): made when the team is
 * installed, archived when it's taken off. Reads only GETHUGS_URL and GETHUGS_PARTNER_TOKEN from `.env`; skips without
 * them.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { to_hug_file } from '@getcliqio/cliq-sdk';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { Org, OrgMember, OrgRole, Team, User } from '../../src/models/index.js';
import { publish_version } from './helpers/version_files.js';
import { RealmTeamListService } from '../../src/services/realm_team_list.service.js';
import { seed_default_roles_for_org } from '../../src/models/migrations/migrate_org_roles.js';
import { gethugs_partner } from '../../src/services/gethugs.service.js';
import { gethugs_reconcile } from '../../src/services/gethugs_reconcile.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { RealmService } from '../../src/services/realm.service.js';

function gethugs_from_dotenv(): boolean {
    let text = '';
    try {
        text = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    } catch {
        return false;
    }
    const env = parseEnv(text);
    if (!env.GETHUGS_URL || !env.GETHUGS_PARTNER_TOKEN) return false;
    process.env.GETHUGS_URL = env.GETHUGS_URL;
    process.env.GETHUGS_PARTNER_TOKEN = env.GETHUGS_PARTNER_TOKEN;
    return true;
}

const configured = gethugs_from_dotenv();
const has_postgres = await postgres_reachable();
const uid = () => `lv${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe.skipIf(!configured || !has_postgres)('the getHugs reconcile, live (local stack)', () => {
    let org_id = '';
    const more_orgs: string[] = [];

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
    });
    afterAll(async () => {
        for (const id of more_orgs) {
            const r = { replacements: { org_id: id } };
            await get_sequelize().query('DELETE FROM cliq.realm_teams WHERE realm_id IN (SELECT id FROM cliq.realms WHERE org_id = :org_id)', r);
            await get_sequelize().query('DELETE FROM cliq.realm_members WHERE realm_id IN (SELECT id FROM cliq.realms WHERE org_id = :org_id)', r);
            await get_sequelize().query('DELETE FROM cliq.realms WHERE org_id = :org_id', r);
            await Org.destroy({ where: { id } });
        }
        if (org_id) {
            const r = { replacements: { org_id } };
            await get_sequelize().query('DELETE FROM cliq.notification_channels WHERE org_id = :org_id OR realm_id IN (SELECT id FROM cliq.realms WHERE org_id = :org_id)', r);
            await get_sequelize().query('DELETE FROM cliq.realm_members WHERE realm_id IN (SELECT id FROM cliq.realms WHERE org_id = :org_id)', r);
            await get_sequelize().query('DELETE FROM cliq.realms WHERE org_id = :org_id', r);
            await Org.destroy({ where: { id: org_id } });
        }
        await close_test_control_plane_store();
    });

    it('provisions an org, matches on a second run, and suspends it when deleted', async () => {
        const partner = gethugs_partner()!;
        const person = async (role_slug: string) => {
            const name = uid();
            const id = randomUUID();
            await User.create({ id, username: name, email: `${name}@cliq.test`, display_name: name, status: 'active', role: 'user', password_hash: 'x' } as never);
            return { id, role_slug };
        };
        const owner = await person('owner');
        const org = await Org.create({ slug: uid(), display_name: `Live ${uid()}`, status: 'active', owner_id: owner.id, activated_at: new Date() } as never);
        org_id = org.id;
        await seed_default_roles_for_org(org.id);
        const members = [owner, await person('admin'), await person('member')];
        for (const m of members) {
            const role = await OrgRole.findOne({ where: { org_id: org.id, slug: m.role_slug }, attributes: ['id'], raw: true });
            await OrgMember.create({ org_id: org.id, user_id: m.id, role: m.role_slug === 'member' ? 'member' : 'admin', role_id: role!.id, status: 'active', joined_at: new Date() } as never);
        }
        await RealmService.create(owner.id, 'default', 'Main', { org_id: org.id });
        const ops = await RealmService.create(owner.id, uid(), 'Ops', { org_id: org.id });
        await NotificationService.create_channel({ org_id: org.id, name: 'alerts', destinations: [{ type: 'email', address: 'ops@cliq.test' }] });
        await NotificationService.create_channel({ realm_id: ops.id, name: 'oncall', destinations: [{ type: 'channel_ref', name: 'alerts' }, { type: 'slack', webhook_url: 'https://devops.slack.com' }] });

        const first = await gethugs_reconcile(org.id, partner);
        expect(first.gethugs_org_id).toMatch(/^org_/);
        expect(first.report.map((r) => r.reason)).toEqual(['invalid_request']);

        const g_org = first.gethugs_org_id!;
        const read = <T>(path: string, body: object) => partner.site.call<T>(path, body);
        const people = (await read<{ items: Array<{ external: { id: string } | null; role: { slug: string } }> }>('users/get', { org_id: g_org, type: 'person' })).items;
        expect(people.map((p) => `${p.external?.id}:${p.role.slug}`).sort()).toEqual(members.map((m) => `user:${m.id}:${m.role_slug}`).sort());
        const workspaces = (await read<{ items: Array<{ id: string; name: string; external: { id: string } | null }> }>('workspaces/get', { org_id: g_org })).items;
        expect(workspaces.map((w) => w.name).sort()).toEqual(['Main', 'Ops']);
        const ops_ws = workspaces.find((w) => w.external?.id === `realm:${ops.id}`)!;
        const ops_members = (await read<{ items: Array<{ role: string }> }>('workspaces/get_members', { org_id: g_org, workspace_id: ops_ws.id })).items;
        expect(ops_members.map((m) => m.role).sort()).toEqual(['admin', 'admin']); // the owner (its creator) and the org admin

        // Nothing changed: only the refused Slack URL is tried again.
        expect((await gethugs_reconcile(org.id, partner)).writes).toHaveLength(1);

        await Org.update({ status: 'deleted', deleted_at: new Date() } as never, { where: { id: org.id } });
        expect((await gethugs_reconcile(org.id, partner)).writes).toEqual([`site/suspend_org org:${org.id}`]);
        const after = await read<{ status: string }>('site/get_org_by_id', { org_id: g_org });
        expect(after.status).toBe('suspended');
    });

    it('a team hug is a template in getHugs while its team is installed; archived when it is taken off', async () => {
        const partner = gethugs_partner();
        const owner = randomUUID();
        const name = uid();
        await User.create({ id: owner, username: name, email: `${name}@cliq.test`, display_name: name, status: 'active', role: 'user', password_hash: 'x' } as never);
        const org = await Org.create({ slug: uid(), display_name: `Live templates ${uid()}`, status: 'active', owner_id: owner, activated_at: new Date() } as never);
        more_orgs.push(org.id);
        await seed_default_roles_for_org(org.id);
        const role = await OrgRole.findOne({ where: { org_id: org.id, slug: 'owner' }, attributes: ['id'], raw: true });
        await OrgMember.create({ org_id: org.id, user_id: owner, role: 'admin', role_id: role!.id, status: 'active', joined_at: new Date() } as never);
        const realm = await RealmService.create(owner, 'default', 'Main', { org_id: org.id });

        const slug = `live-${uid()}`.slice(0, 30);
        const team = await Team.create({ id: randomUUID(), name: slug, scope: 'livetest', description: 't', author_id: owner, license: 'MIT', visibility: 'public', listed: 1, install_count: 0 } as never);
        const hug = to_hug_file({
            'hug.json': JSON.stringify({ name: 'review', title: 'Review', description: 'Asks for a review', sdk_version: '1.2.0', definition: 'definition.mjs' }),
            'index.html': '<!doctype html><script type="module" src="./main.js"></script>',
            'main.js': 'console.log(1)',
            'definition.mjs': 'export default {}',
        });
        const v1 = await publish_version(team.id, '1.0.0', { name: `@livetest/${slug}`, phases: [] }, { 'hugs/review.hug': hug });
        await RealmTeamListService.add(realm.id, owner, { team_id: team.id, version_id: v1 });

        const first = await gethugs_reconcile(org.id, partner);
        expect(first.report).toEqual([]);
        const g_org = first.gethugs_org_id!;
        const tname = `@livetest/${slug}/review`;
        const list = async () => (await partner.site.call<{ items: Array<{ name: string; builtin: boolean; archived_at: number | null; current_version: { id: string } | null }> }>(
            'templates/get', { org_id: g_org, include_archived: true })).items.filter((t) => t.name === tname);
        const [made] = await list();
        expect(made).toMatchObject({ builtin: false, archived_at: null });
        expect(made!.current_version).not.toBeNull();
        expect((await gethugs_reconcile(org.id, partner)).writes).toEqual([]);

        await RealmTeamListService.remove(realm.id, owner, team.id);
        expect((await gethugs_reconcile(org.id, partner)).writes).toEqual([`templates/delete template:${tname}`]);
        const [archived] = await list();
        expect(archived!.archived_at).not.toBeNull();
    });
});
