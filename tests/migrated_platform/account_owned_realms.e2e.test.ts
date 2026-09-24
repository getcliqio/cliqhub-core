/**
 * End-to-end: account-owned realms across multiple users.
 *
 * Covers signup → login → me → org-scoped personal default realm
 * (slug = 'default', scoped by org via UNIQUE(org_id, slug)),
 * listing/creating realms, inviting (add_member), role changes,
 * remove_member, multi-realm isolation (by realm_id, since
 * every personal default shares the slug 'default'), and Hub scopes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Op } from 'sequelize';

import { postgres_reachable } from './helpers/control_plane_store.js';
import {
    close_live_hub_app,
    open_live_hub_app,
} from './helpers/live_hub_app.js';
import { User, Scope, Org, OrgMember, ScopeMember, AuditLog } from '../../src/db/models/index.js';
import {
    Realm,
    RealmMember,
    NotificationChannel,
    RealmDispatchKey,
} from '../../src/models/index.js';
import { get_sequelize } from '../../src/db/sequelize.js';

const has_postgres = await postgres_reachable();
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = 'password123';

type Session = {
    username: string;
    email: string;
    user_id: string;
    token: string;
    default_realm_id: string;
    default_realm_slug: string;
};

function bearer(token: string): string {
    return `Bearer ${token}`;
}

async function cleanup_usernames(usernames: string[]): Promise<void> {
    if (usernames.length === 0) return;
    const users = await User.findAll({
        where: { username: { [Op.in]: usernames } },
        attributes: ['id', 'username', 'default_realm_id'],
    });
    const user_ids = users.map((u) => String(u.id));
    const numeric_ids = users.map((u) => u.id);
    const realm_ids = new Set<string>();
    for (const u of users) {
        if (u.default_realm_id) realm_ids.add(u.default_realm_id);
    }
    if (user_ids.length > 0) {
        const owned = await Realm.findAll({
            where: { owner_user_id: { [Op.in]: user_ids } },
            attributes: ['id'],
        });
        for (const r of owned) realm_ids.add(r.id);
        const memberships = await RealmMember.findAll({
            where: { member_type: 'user', member_id: { [Op.in]: user_ids } },
            attributes: ['realm_id'],
        });
        for (const m of memberships) realm_ids.add(m.realm_id);
    }

    if (numeric_ids.length > 0) {
        await User.update(
            { default_realm_id: null },
            { where: { id: { [Op.in]: numeric_ids } } },
        );
    }

    for (const realm_id of realm_ids) {
        await RealmMember.destroy({ where: { realm_id } });
        await NotificationChannel.destroy({ where: { realm_id } });
        await RealmDispatchKey.destroy({ where: { realm_id } });
        await Realm.destroy({ where: { id: realm_id } });
    }

    if (numeric_ids.length > 0) {
        const owned_scopes = await Scope.findAll({
            where: { owner_id: { [Op.in]: numeric_ids } },
            attributes: ['id'],
        });
        const scope_ids = owned_scopes.map((s) => s.id);
        if (scope_ids.length > 0) {
            await Org.update(
                { default_scope_id: null },
                { where: { default_scope_id: { [Op.in]: scope_ids } } },
            );
            await ScopeMember.destroy({
                where: { scope_id: { [Op.in]: scope_ids } },
            });
            await Scope.destroy({ where: { id: { [Op.in]: scope_ids } } });
        }

        const org_memberships = await OrgMember.findAll({
            where: { user_id: { [Op.in]: numeric_ids } },
            attributes: ['org_id'],
        });
        const org_ids = [...new Set(org_memberships.map((m) => m.org_id))];
        await OrgMember.destroy({
            where: { user_id: { [Op.in]: numeric_ids } },
        });
        if (org_ids.length > 0) {
            await Org.destroy({ where: { id: { [Op.in]: org_ids } } });
        }

        await AuditLog.destroy({ where: { admin_id: { [Op.in]: numeric_ids } } });
        const sequelize = get_sequelize();
        await sequelize.query(
            `DELETE FROM tokens WHERE user_id IN (:ids)`,
            { replacements: { ids: numeric_ids } },
        );
    }

    await User.destroy({ where: { username: { [Op.in]: usernames } } });
}

describe.skipIf(!has_postgres)('account-owned realms e2e (multi-user)', () => {
    let app: Express;
    const tracked: string[] = [];
    let alice: Session;
    let bob: Session;
    let carol: Session;

    async function signup(label: string): Promise<Session> {
        const username = `e2e${label}${stamp}`.slice(0, 32).toLowerCase();
        const account_slug = username;
        const email = `${username}@e2e.test`;
        tracked.push(username);
        const res = await request(app)
            .post('/internal/auth/signup')
            .send({ username, email, password });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        const data = res.body.data;
        expect(data.token).toBeTruthy();
        expect(data.account_slug).toBe(account_slug);
        expect(data.default_realm_id).toBeTruthy();
        expect(data.default_realm_slug).toBe('default');
        expect(data.default_realm_qualified).toBe(`${account_slug}.default`);
        expect(data.enroll_token).toMatch(/^cliq_dt_/);
        expect(data.user.username).toBe(username);
        return {
            username,
            email,
            user_id: data.user.id as number,
            token: data.token as string,
            default_realm_id: data.default_realm_id as string,
            default_realm_slug: data.default_realm_slug as string,
        };
    }

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        const live = await open_live_hub_app();
        app = live.app;
        alice = await signup('alice');
        bob = await signup('bob');
        carol = await signup('carol');
    }, 300_000);

    afterAll(async () => {
        await cleanup_usernames(tracked);
        await close_live_hub_app();
    }, 300_000);

    it('login, scopes expose personal default realm', async () => {
        const login = await request(app)
            .post('/internal/auth/authenticate_user')
            .send({ username: alice.username, password });
        expect(login.status).toBe(200);
        expect(login.body.data.default_realm_id).toBe(alice.default_realm_id);
        expect(login.body.data.default_realm_slug).toBe(alice.default_realm_slug);
        expect(login.body.data.scopes).toContain(alice.username);

        const scopes = await request(app)
            .post('/v1/scopes/get')
            .set('Authorization', bearer(login.body.data.token))
            .send({ mine: true });
        expect(scopes.status).toBe(200);
        const scope_slugs = (scopes.body.data.scopes as Array<{ slug: string }>).map((s) => s.slug);
        expect(scope_slugs).toContain(alice.username);

        const alice_realms = await request(app)
            .post('/v1/realms/get')
            .set('Authorization', bearer(alice.token))
            .send({});
        expect(alice_realms.status).toBe(200);
        const personal = (alice_realms.body.realms as Array<{ id: string; slug: string; name: string }>)
            .find((r) => r.id === alice.default_realm_id);
        expect(personal?.slug).toBe('default');

        const bob_realms = await request(app)
            .post('/v1/realms/get')
            .set('Authorization', bearer(bob.token))
            .send({});
        const bob_ids = (bob_realms.body.realms as Array<{ id: string }>).map((r) => r.id);
        expect(bob_ids).toContain(bob.default_realm_id);
        expect(bob_ids).not.toContain(alice.default_realm_id);
    });

    it('multi-user multi-realm: invite, roles, remove, isolation', async () => {
        const shared_a = `share-a-${stamp}`.slice(0, 40);
        const shared_b = `share-b-${stamp}`.slice(0, 40);

        const create_a = await request(app)
            .post('/v1/realms/create')
            .set('Authorization', bearer(alice.token))
            .send({ slug: shared_a, name: 'Shared A' });
        expect(create_a.status).toBe(200);
        const realm_a = create_a.body.realm.id as string;
        expect(create_a.body.realm.owner_user_id).toBe(String(alice.user_id));

        const create_b = await request(app)
            .post('/v1/realms/create')
            .set('Authorization', bearer(alice.token))
            .send({ slug: shared_b, name: 'Shared B' });
        expect(create_b.status).toBe(200);
        const realm_b = create_b.body.realm.id as string;

        const invite_bob = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer(alice.token))
            .send({
                realm_id: realm_a,
                member_type: 'user',
                member_id: String(bob.user_id),
                role: 'operator',
            });
        expect(invite_bob.status).toBe(200);
        expect(invite_bob.body.member).toMatchObject({
            member_type: 'user',
            member_id: String(bob.user_id),
            role: 'operator',
        });

        const invite_carol = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer(alice.token))
            .send({
                realm_id: realm_b,
                member_type: 'user',
                member_id: String(carol.user_id),
                role: 'member',
            });
        expect(invite_carol.status).toBe(200);

        const bob_list = await request(app)
            .post('/v1/realms/get')
            .set('Authorization', bearer(bob.token))
            .send({});
        const bob_realms_view = bob_list.body.realms as Array<{ id: string; slug: string }>;
        const bob_ids = new Set(bob_realms_view.map((r) => r.id));
        const bob_slugs = new Set(bob_realms_view.map((r) => r.slug));
        expect(bob_ids.has(bob.default_realm_id)).toBe(true);
        expect(bob_slugs.has(shared_a)).toBe(true);
        expect(bob_slugs.has(shared_b)).toBe(false);
        // Isolation: bob must NOT see alice's personal realm (same slug 'default',
        // different realm id / different org).
        expect(bob_ids.has(alice.default_realm_id)).toBe(false);

        const carol_list = await request(app)
            .post('/v1/realms/get')
            .set('Authorization', bearer(carol.token))
            .send({});
        const carol_slugs = new Set(
            (carol_list.body.realms as Array<{ slug: string }>).map((r) => r.slug),
        );
        expect(carol_slugs.has(shared_b)).toBe(true);
        expect(carol_slugs.has(shared_a)).toBe(false);

        const alice_list = await request(app)
            .post('/v1/realms/get')
            .set('Authorization', bearer(alice.token))
            .send({});
        const alice_realms_view = alice_list.body.realms as Array<{ id: string; slug: string }>;
        const alice_ids = new Set(alice_realms_view.map((r) => r.id));
        const alice_slugs = new Set(alice_realms_view.map((r) => r.slug));
        expect(alice_ids.has(alice.default_realm_id)).toBe(true);
        expect(alice_slugs.has(shared_a)).toBe(true);
        expect(alice_slugs.has(shared_b)).toBe(true);

        const members_a = await request(app)
            .post('/v1/realms/get_members')
            .set('Authorization', bearer(bob.token))
            .send({ realm_id: realm_a, member_type: 'user' });
        expect(members_a.status).toBe(200);
        const roles = new Map(
            (members_a.body.members as Array<{ member_id: string; role: string }>)
                .map((m) => [m.member_id, m.role]),
        );
        expect(roles.get(String(alice.user_id))).toBe('admin');
        expect(roles.get(String(bob.user_id))).toBe('operator');

        const bob_mint = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer(bob.token))
            .send({ type: 'realm', realm_ids: [realm_a], name: 'operator-ok' });
        expect([200, 201]).toContain(bob_mint.status);

        const alice_mint = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', bearer(alice.token))
            .send({ type: 'realm', realm_ids: [realm_a], name: 'ok-token' });
        expect([200, 201]).toContain(alice_mint.status);

        // Role upgrade via add_member (upsert)
        const promote = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer(alice.token))
            .send({
                realm_id: realm_a,
                member_type: 'user',
                member_id: String(bob.user_id),
                role: 'admin',
            });
        expect(promote.status).toBe(200);

        const bob_invites_carol = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer(bob.token))
            .send({
                realm_id: realm_a,
                member_type: 'user',
                member_id: String(carol.user_id),
                role: 'member',
            });
        expect(bob_invites_carol.status).toBe(200);

        const revoke_carol = await request(app)
            .post('/v1/realms/remove_member')
            .set('Authorization', bearer(alice.token))
            .send({
                realm_id: realm_a,
                member_type: 'user',
                member_id: String(carol.user_id),
            });
        expect(revoke_carol.status).toBe(200);

        const remove_bob = await request(app)
            .post('/v1/realms/remove_member')
            .set('Authorization', bearer(alice.token))
            .send({
                realm_id: realm_a,
                member_type: 'user',
                member_id: String(bob.user_id),
            });
        expect(remove_bob.status).toBe(200);

        const bob_after = await request(app)
            .post('/v1/realms/get')
            .set('Authorization', bearer(bob.token))
            .send({});
        expect(
            (bob_after.body.realms as Array<{ slug: string }>).some((r) => r.slug === shared_a),
        ).toBe(false);

        const bob_get_a = await request(app)
            .post('/v1/realms/get_by_id')
            .set('Authorization', bearer(bob.token))
            .send({ realm_id: realm_a });
        expect(bob_get_a.status).toBe(403);

        const carol_invite = await request(app)
            .post('/v1/realms/add_member')
            .set('Authorization', bearer(carol.token))
            .send({
                realm_id: realm_b,
                member_type: 'user',
                member_id: String(bob.user_id),
                role: 'member',
            });
        expect(carol_invite.status).toBe(403);
    });

    it('org create / add_member ensures {org}.default and grants members', async () => {
        await User.update({ role: 'admin' }, { where: { id: alice.user_id } });

        const org_slug = `orge2e${stamp}`.slice(0, 24);

        const created = await request(app)
            .post('/internal/orgs/new')
            .set('Authorization', bearer(alice.token))
            .send({
                slug: org_slug,
                display_name: 'E2E Org',
                admin_username: alice.username,
            });
        expect(created.status).toBe(200);
        const org_id = created.body.data.id as number;

        const org_default = await Realm.findOne({
            where: { org_id, slug: 'default' },
        });
        expect(org_default).not.toBeNull();
        expect(org_default!.owner_user_id).toBe(String(alice.user_id));
        expect(org_default!.created_by).toBe(String(alice.user_id));

        const add = await request(app)
            .post('/internal/orgs/add_member')
            .set('Authorization', bearer(alice.token))
            .send({ org_id, username: bob.username });
        expect(add.status).toBe(200);

        const bob_realms = await request(app)
            .post('/v1/realms/get')
            .set('Authorization', bearer(bob.token))
            .send({});
        const bob_realms_view = bob_realms.body.realms as Array<{ id: string; slug: string }>;
        const bob_ids = new Set(bob_realms_view.map((r) => r.id));
        // Bob still sees his personal default realm.
        expect(bob_ids.has(bob.default_realm_id)).toBe(true);
        // Bob now sees the new org's default realm (same slug 'default', different org/id).
        expect(bob_ids.has(org_default!.id)).toBe(true);
        // No stray org-* legacy slugs.
        expect(bob_realms_view.some((r) => r.slug.startsWith('org-'))).toBe(false);

        await ScopeMember.destroy({
            where: {
                scope_id: {
                    [Op.in]: (
                        await Scope.findAll({ where: { org_id }, attributes: ['id'] })
                    ).map((s) => s.id),
                },
            },
        });
        await Scope.destroy({ where: { org_id } });
        await OrgMember.destroy({ where: { org_id } });
        await Org.destroy({ where: { id: org_id } });
    });
});
