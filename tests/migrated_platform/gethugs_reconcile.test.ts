/**
 * PLAN-gethugs-step2-provisioning.md sub-step 3: the reconcile makes a fake getHugs match a cliq org — every row of
 * the mapping, refusals reported, a second run that writes nothing, and repairs. And `runs_viewers` agrees with the
 * route policy's `visible_realm_ids(…, { perm: 'runs.view' })`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { FakeGethugs } from '../helpers/fake_gethugs.js';
import { runs_viewers, users_with_runs_view, visible_realm_ids } from '../../src/auth/route_policy/visible.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { Org, OrgMember, OrgRole, Realm, RealmMember, User } from '../../src/models/index.js';
import { seed_default_roles_for_org } from '../../src/models/migrations/migrate_org_roles.js';
import { GethugsPartner } from '../../src/services/gethugs.service.js';
import { gethugs_reconcile } from '../../src/services/gethugs_reconcile.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { RealmService } from '../../src/services/realm.service.js';

const has_postgres = await postgres_reachable();
const uid = () => `gr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const SLACK_OK = 'https://hooks.slack.com/services/T000/B000/abcd1234';

describe.skipIf(!has_postgres)('the getHugs reconcile', () => {
    const orgs: string[] = [];
    let fake: FakeGethugs;
    let partner: GethugsPartner;

    async function person(name = uid()): Promise<{ id: string; username: string; email: string }> {
        const id = randomUUID();
        await User.create({ id, username: name, email: `${name}@cliq.test`, display_name: name, status: 'active', role: 'user', password_hash: 'x' } as never);
        return { id, username: name, email: `${name}@cliq.test` };
    }
    async function role_id(org_id: string, slug: string): Promise<string> {
        return String((await OrgRole.findOne({ where: { org_id, slug }, attributes: ['id'], raw: true }))!.id);
    }
    async function join(org_id: string, user_id: string, slug: string): Promise<void> {
        await OrgMember.create({ org_id, user_id, role: slug === 'owner' || slug === 'admin' ? 'admin' : 'member', role_id: await role_id(org_id, slug), status: 'active', joined_at: new Date() } as never);
    }
    async function realm_member(realm_id: string, user_id: string, role: string): Promise<void> {
        await RealmMember.create({ id: randomUUID(), realm_id, member_type: 'user', member_id: user_id, role, created_at: Date.now() } as never);
    }

    /**
     * An org with an owner, Ann (admin), Bob (member), Cat (a role without runs.view); realms `default` and `ops`
     * (Bob operator, Cat member); an org channel `alerts` and an `ops` channel `oncall`.
     */
    async function cliq_org() {
        const owner = await person();
        const slug = uid();
        const org = await Org.create({ slug, display_name: 'Acme', status: 'active', owner_id: owner.id, activated_at: new Date() } as never);
        orgs.push(org.id);
        await seed_default_roles_for_org(org.id);
        await OrgRole.create({ org_id: org.id, slug: 'no-runs', name: 'No runs', permissions: ['org.settings'], is_system: false, is_default: false } as never);
        await join(org.id, owner.id, 'owner');
        const [ann, bob, cat] = [await person(), await person(), await person()];
        await join(org.id, ann.id, 'admin');
        await join(org.id, bob.id, 'member');
        await join(org.id, cat.id, 'no-runs');
        const default_realm = await RealmService.create(owner.id, 'default', 'Acme', { org_id: org.id });
        const ops = await RealmService.create(owner.id, uid(), 'Ops', { org_id: org.id });
        await realm_member(ops.id, bob.id, 'operator');
        await realm_member(ops.id, cat.id, 'member');
        const alerts = await NotificationService.create_channel({
            org_id: org.id, name: 'alerts',
            destinations: [{ type: 'email', address: 'ops@acme.test, pager@acme.test' }, { type: 'slack', webhook_url: SLACK_OK }, { type: 'cliqhub' }],
        });
        const oncall = await NotificationService.create_channel({
            realm_id: ops.id, name: 'oncall',
            destinations: [{ type: 'channel_ref', name: 'alerts' }, { type: 'channel_ref', name: bob.username }, { type: 'slack', webhook_url: 'https://devops.slack.com' }],
        });
        return { org_id: org.id, owner, ann, bob, cat, default_realm: default_realm.id, ops: ops.id, alerts: alerts.id, oncall: oncall.id };
    }

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
    });
    beforeEach(() => {
        fake = new FakeGethugs();
        partner = new GethugsPartner({ url: 'http://gethugs.test', token: 'hugs_svc_test', app_url: 'http://app.gethugs.test' }, fake.fetch);
    });
    afterAll(async () => {
        if (orgs.length) {
            const ids = { replacements: { ids: orgs } };
            await get_sequelize().query('DELETE FROM cliq.notification_channels WHERE realm_id IN (SELECT id FROM cliq.realms WHERE org_id = ANY(ARRAY[:ids]::uuid[])) OR org_id = ANY(ARRAY[:ids]::uuid[])', ids);
            await get_sequelize().query('DELETE FROM cliq.realm_members WHERE realm_id IN (SELECT id FROM cliq.realms WHERE org_id = ANY(ARRAY[:ids]::uuid[]))', ids);
            await get_sequelize().query('DELETE FROM cliq.realms WHERE org_id = ANY(ARRAY[:ids]::uuid[])', ids);
            await Org.destroy({ where: { id: orgs } });
        }
        await close_test_control_plane_store();
    });

    it('runs_viewers agrees with the route policy (runs.view) for every member', async () => {
        const o = await cliq_org();
        const viewers = await runs_viewers(o.org_id);
        for (const u of [o.owner, o.ann, o.bob, o.cat]) {
            const allowed = (await visible_realm_ids(u.id, { org_id: o.org_id, perm: 'runs.view' })).sort();
            const mine = [...viewers].filter(([, users]) => users.has(u.id)).map(([realm]) => realm).sort();
            expect(mine).toEqual(allowed);
        }
        const ops = await users_with_runs_view(o.ops);
        expect(Object.fromEntries([...ops].map(([u, l]) => [u, l]))).toEqual({ [o.owner.id]: 'admin', [o.ann.id]: 'admin', [o.bob.id]: 'operate' });
    });

    it('provisions an org: owner without an invitation, people, workspaces with members, channels; refusals reported; a second run writes nothing', async () => {
        const o = await cliq_org();
        const first = await gethugs_reconcile(o.org_id, partner);

        const org = fake.org_by_ref(`org:${o.org_id}`)!;
        expect(first.gethugs_org_id).toBe(org.id);
        expect(org.name).toBe('Acme');
        expect(fake.invites).toEqual([]);

        const role_of = (u: { id: string }) => fake.role_slug(fake.user_by_ref(org.id, `user:${u.id}`)!.role_id);
        expect([role_of(o.owner), role_of(o.ann), role_of(o.bob), role_of(o.cat)]).toEqual(['owner', 'admin', 'member', 'member']);

        const g = (u: { id: string }) => fake.user_by_ref(org.id, `user:${u.id}`)!.id;
        const default_ws = fake.workspace_by_ref(org.id, `realm:${o.default_realm}`)!;
        const ops_ws = fake.workspace_by_ref(org.id, `realm:${o.ops}`)!;
        expect(fake.workspaces.filter((w) => w.org_id === org.id)).toHaveLength(2);
        expect(Object.fromEntries(default_ws.members)).toEqual({ [g(o.owner)]: 'admin', [g(o.ann)]: 'admin' });
        // Cat's role has no runs.view: not in any workspace.
        expect(Object.fromEntries(ops_ws.members)).toEqual({ [g(o.owner)]: 'admin', [g(o.ann)]: 'admin', [g(o.bob)]: 'operator' });

        const alerts = fake.channel_by_ref(org.id, `channel:${o.alerts}`)!;
        const oncall = fake.channel_by_ref(org.id, `channel:${o.oncall}`)!;
        expect([alerts.workspace_id, oncall.workspace_id]).toEqual([null, ops_ws.id]);
        const dests = (c: { id: string }) => fake.dests.filter((d) => d.channel_id === c.id).map((d) => d.type === 'channel'
            ? `channel:${fake.channels.find((x) => x.id === d.target_channel_id)!.personal_user_id ?? d.target_channel_id}` : `${d.type}:${String(d.config.address ?? d.config.url)}`).sort();
        expect(dests(alerts)).toEqual(['email:ops@acme.test', 'email:pager@acme.test', `slack:${SLACK_OK}`]);
        expect(dests(oncall)).toEqual([`channel:${alerts.id}`, `channel:${g(o.bob)}`].sort());

        expect(first.report.map((r) => `${r.kind}:${r.reason}`).sort()).toEqual(['destination:in_app_not_mirrored', 'destination:invalid_slack_url']);

        const [links] = await get_sequelize().query('SELECT kind, count(*)::int AS n FROM cliq.gethugs_links WHERE org_id = :org_id GROUP BY kind ORDER BY kind', { replacements: { org_id: o.org_id } });
        expect(links).toEqual([{ kind: 'channel', n: 2 }, { kind: 'org', n: 1 }, { kind: 'realm', n: 2 }, { kind: 'user', n: 4 }]);

        const before = fake.writes().length;
        const second = await gethugs_reconcile(o.org_id, partner);
        // The Slack URL getHugs won't take is reported again, never sent; nothing is written.
        expect(second.writes).toEqual([]);
        expect(second.report.map((r) => r.reason).sort()).toEqual(['in_app_not_mirrored', 'invalid_slack_url']);
        expect(fake.writes().length).toBe(before);
    });

    it('repairs: names, a removed member, a suspended person, an email, an edited and a removed channel, a deleted realm, an ownership move', async () => {
        const o = await cliq_org();
        const old = await RealmService.create(o.owner.id, uid(), 'Old', { org_id: o.org_id });
        await gethugs_reconcile(o.org_id, partner);
        const org = fake.org_by_ref(`org:${o.org_id}`)!;
        const g = (u: { id: string }) => fake.user_by_ref(org.id, `user:${u.id}`)!;

        await Org.update({ display_name: 'Acme Inc' } as never, { where: { id: o.org_id } });
        await RealmService.update(o.default_realm, o.owner.id, { name: 'Main' });
        await OrgMember.update({ deleted_at: new Date() } as never, { where: { org_id: o.org_id, user_id: o.bob.id } });
        await User.update({ suspended_at: new Date(), status: 'suspended' } as never, { where: { id: o.cat.id } });
        const ann_email = `${uid()}@cliq.test`;
        await User.update({ email: ann_email } as never, { where: { id: o.ann.id } });
        await NotificationService.update_channel({ id: o.alerts, name: 'alerts-2', destinations: [{ type: 'email', address: 'ops@acme.test' }, { type: 'webhook', url: 'https://hooks.acme.test/in' }] } as never);
        await NotificationService.remove_channel(o.oncall);
        await Realm.update({ deleted: true, deleted_at: Date.now() } as never, { where: { id: old.id } });
        // Ann becomes the owner; the old owner an admin.
        await OrgMember.update({ role_id: await role_id(o.org_id, 'owner') } as never, { where: { org_id: o.org_id, user_id: o.ann.id } });
        await OrgMember.update({ role_id: await role_id(o.org_id, 'admin') } as never, { where: { org_id: o.org_id, user_id: o.owner.id } });
        await Org.update({ owner_id: o.ann.id } as never, { where: { id: o.org_id } });

        const result = await gethugs_reconcile(o.org_id, partner);
        expect(result.report.filter((r) => r.reason !== 'in_app_not_mirrored')).toEqual([]);
        expect(org.name).toBe('Acme Inc');
        expect(fake.workspace_by_ref(org.id, `realm:${o.default_realm}`)!.name).toBe('Main');
        expect(fake.workspace_by_ref(org.id, `realm:${old.id}`)!.archived_at).not.toBeNull();
        expect([g(o.bob).status, g(o.cat).status]).toEqual(['deactivated', 'deactivated']);
        expect(g(o.ann).email).toBe(ann_email);
        expect([fake.role_slug(g(o.ann).role_id), fake.role_slug(g(o.owner).role_id)]).toEqual(['owner', 'admin']);

        const alerts = fake.channel_by_ref(org.id, `channel:${o.alerts}`)!;
        expect(alerts.name).toBe('alerts-2');
        expect(fake.dests.filter((d) => d.channel_id === alerts.id).map((d) => `${d.type}:${String(d.config.address ?? d.config.url)}`).sort())
            .toEqual(['email:ops@acme.test', 'webhook:https://hooks.acme.test/in']);
        expect(fake.channel_by_ref(org.id, `channel:${o.oncall}`)!.archived_at).not.toBeNull();

        expect((await gethugs_reconcile(o.org_id, partner)).writes).toEqual([]);
    });

    it('an org waiting for its owner is not provisioned; deleted it is suspended; restored it comes back', async () => {
        const o = await cliq_org();
        await Org.update({ status: 'waiting_for_owner' } as never, { where: { id: o.org_id } });
        expect(await gethugs_reconcile(o.org_id, partner)).toEqual({ gethugs_org_id: null, writes: [], report: [] });
        expect(fake.orgs).toEqual([]);

        await Org.update({ status: 'active' } as never, { where: { id: o.org_id } });
        await gethugs_reconcile(o.org_id, partner);
        const org = fake.org_by_ref(`org:${o.org_id}`)!;

        await Org.update({ status: 'deleted', deleted_at: new Date() } as never, { where: { id: o.org_id } });
        // A deleted org is only suspended.
        expect((await gethugs_reconcile(o.org_id, partner)).writes).toEqual([`site/suspend_org org:${o.org_id}`]);
        expect(org.status).toBe('suspended');

        await Org.update({ status: 'active', deleted_at: null } as never, { where: { id: o.org_id } });
        // Restored.
        expect((await gethugs_reconcile(o.org_id, partner)).writes).toEqual([`site/restore_org org:${o.org_id}`]);
        expect(org.status).toBe('active');
    });

    it('an active org with no realm waits (reported, not failed); its first realm, whatever its slug, provisions it', async () => {
        const owner = await person();
        const org = await Org.create({ slug: uid(), display_name: 'Bare', status: 'active', owner_id: owner.id } as never);
        orgs.push(org.id);
        await seed_default_roles_for_org(org.id);
        await join(org.id, owner.id, 'owner');
        expect(await gethugs_reconcile(org.id, partner)).toEqual({
            gethugs_org_id: null, writes: [], report: [expect.objectContaining({ kind: 'org', cliq_id: org.id, reason: 'no_realm_yet' })],
        });
        expect(fake.orgs).toEqual([]);

        // A legacy slug, not `default`: still the org's first workspace.
        const legacy = await RealmService.create(owner.id, `${uid()}-default-realm`, 'Bare', { org_id: org.id });
        const run = await gethugs_reconcile(org.id, partner);
        const g = fake.org_by_ref(`org:${org.id}`)!;
        expect(run.gethugs_org_id).toBe(g.id);
        expect(fake.workspace_by_ref(g.id, `realm:${legacy.id}`)!.name).toBe('Bare');
    });

    it('realms whose names clash (ignoring case) get workspaces named with their slug; stable on the next run', async () => {
        const o = await cliq_org();
        const twin_slug = uid();
        const twin = await RealmService.create(o.owner.id, twin_slug, 'acme', { org_id: o.org_id });
        const first = await gethugs_reconcile(o.org_id, partner);
        const g = fake.org_by_ref(`org:${o.org_id}`)!;
        expect(fake.workspace_by_ref(g.id, `realm:${o.default_realm}`)!.name).toBe('Acme');
        expect(fake.workspace_by_ref(g.id, `realm:${twin.id}`)!.name).toBe(`acme (${twin_slug})`);
        expect(first.report.filter((r) => r.kind === 'realm')).toEqual([]);
        expect((await gethugs_reconcile(o.org_id, partner)).writes).toEqual([]);

        // Renamed in cliq onto another realm's name: the same.
        await Realm.update({ name: 'OPS' } as never, { where: { id: twin.id } });
        expect((await gethugs_reconcile(o.org_id, partner)).writes).toEqual([`workspaces/update realm:${twin.id}`]);
        expect(fake.workspace_by_ref(g.id, `realm:${twin.id}`)!.name).toBe(`OPS (${twin_slug})`);
    });

    it('destinations getHugs would refuse are reported and not sent; the rest of the channel is mirrored', async () => {
        const o = await cliq_org();
        const odd = await NotificationService.create_channel({
            org_id: o.org_id, name: 'odd',
            destinations: [{ type: 'email', address: 'ok@acme.test, not-an-address' }, { type: 'webhook', url: 'ftp://files.acme.test/in' }],
        });
        const run = await gethugs_reconcile(o.org_id, partner);
        const g = fake.org_by_ref(`org:${o.org_id}`)!;
        const channel = fake.channel_by_ref(g.id, `channel:${odd.id}`)!;
        expect(fake.dests.filter((d) => d.channel_id === channel.id).map((d) => `${d.type}:${String(d.config.address)}`)).toEqual(['email:ok@acme.test']);
        expect(run.report.filter((r) => r.cliq_id === odd.id).map((r) => r.reason).sort()).toEqual(['invalid_email', 'invalid_webhook_url']);
        expect(run.report.some((r) => r.reason === 'invalid_request')).toBe(false);
    });
});
