/**
 * User, org and token flows over HTTP on live Postgres — the gaps from the
 * user-management audit. Full production app, route policy in enforce mode.
 *
 * Tests named "fixed Bn / Sn" were written against a bug first (seen failing),
 * then the fix landed; they guard against it coming back.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { invite_and_accept } from '../helpers/invite_links.js';
import { use_test_link_env } from '../helpers/link_env.js';
import { randomUUID } from 'node:crypto';
import { ApiToken, Org, OrgMember, OrgRole, Realm, RealmMember, User } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const password = 'password123';

describe.skipIf(!has_postgres)('user, org and token flows', () => {
    let app: Express;
    let s: Seed;
    const bearer = (t: string) => `Bearer ${t}`;
    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        const r = request(app).post(path).send(body);
        return token ? r.set('Authorization', bearer(token)) : r;
    };
    const role_id = async (org_id: string, slug: string) =>
        String((await OrgRole.findOne({ where: { org_id, slug }, attributes: ['id'], raw: true }))!.id);

    let restore_link_env: () => void;

    beforeAll(async () => {
        restore_link_env = use_test_link_env();
        const live = await open_live_hub_app();
        app = live.app;
        s = await seed_authz(app);
    }, 300_000);

    afterAll(async () => {
        await s?.cleanup();
        await close_live_hub_app();
        restore_link_env?.();
    }, 300_000);

    // Invitations: tests/integration/invitations_flow.test.ts.

    describe('org members and roles', () => {
        it('change a member role: needs org.members.manage; owner role cannot be assigned', async () => {
            const u = await s.signup('rolechg');
            await invite_and_accept(app, s.token.adam, u.token, { org_id: s.acme, email: u.email });
            const operator = await role_id(s.acme, 'operator');
            expect((await post('/internal/users/update_role', s.token.mia, { org_id: s.acme, user_id: u.id, role_id: operator })).status).toBe(403);
            expect((await post('/internal/users/update_role', s.token.adam, { org_id: s.acme, user_id: u.id, role_id: operator })).status).toBe(200);
            const m = await OrgMember.findOne({ where: { org_id: s.acme, user_id: u.id }, raw: true });
            expect(m?.role_id).toBe(operator);
            const owner = await role_id(s.acme, 'owner');
            expect((await post('/internal/users/update_role', s.token.adam, { org_id: s.acme, user_id: u.id, role_id: owner })).status).toBeGreaterThanOrEqual(400);
        });

        it('the last org owner cannot be demoted', async () => {
            const member = await role_id(s.acme, 'member');
            expect((await post('/internal/users/update_role', s.token.olivia, { org_id: s.acme, user_id: s.user.olivia, role_id: member })).status).toBe(409);
        });

        it('custom role: create → update → assign → cannot delete while assigned → unassign → delete', async () => {
            const slug = `az-${s.stamp}`.slice(0, 40);
            const created = await post('/v1/orgs/create_role', s.token.adam, { org_id: s.acme, slug, name: 'Auditor', permissions: ['runs.view'] });
            expect(created.status).toBe(200);
            const rid = String((created.body.data.role ?? created.body.data).id);
            expect((await post('/v1/orgs/create_role', s.token.mia, { org_id: s.acme, slug: `${slug}x`, name: 'Nope' })).status).toBe(403);

            const updated = await post('/v1/orgs/update_role', s.token.adam, { org_id: s.acme, role_id: rid, permissions: ['runs.view', 'realms.view'] });
            expect(updated.status).toBe(200);

            const got = await post('/v1/orgs/get_role', s.token.mia, { org_id: s.acme, role_id: rid });
            expect(got.status).toBe(200);
            expect(JSON.stringify(got.body.data)).toContain('realms.view');

            const u = await s.signup('custrole');
            await invite_and_accept(app, s.token.adam, u.token, { org_id: s.acme, email: u.email });
            expect((await post('/internal/users/update_role', s.token.adam, { org_id: s.acme, user_id: u.id, role_id: rid })).status).toBe(200);

            const busy = await post('/v1/orgs/delete_role', s.token.adam, { org_id: s.acme, role_id: rid });
            expect(busy.status).toBeGreaterThanOrEqual(400);

            await post('/internal/users/update_role', s.token.adam, { org_id: s.acme, user_id: u.id, role_id: await role_id(s.acme, 'member') });
            expect((await post('/v1/orgs/delete_role', s.token.adam, { org_id: s.acme, role_id: rid })).status).toBe(200);
        });

        it('list roles and the permission vocabulary', async () => {
            const roles = await post('/v1/orgs/list_roles', s.token.nora, { org_id: s.acme });
            expect(roles.status).toBe(200);
            expect(JSON.stringify(roles.body.data)).toContain('owner');
            expect((await post('/v1/orgs/list_roles', s.token.ben, { org_id: s.acme })).status).toBe(404);
            const perms = await post('/v1/permissions/list', s.token.nora);
            expect(perms.status).toBe(200);
            expect(JSON.stringify(perms.body)).toContain('org.members.manage');
        });

        it('an org admin can leave while another admin remains', async () => {
            const u = await s.signup('leaver');
            await invite_and_accept(app, s.token.adam, u.token, { org_id: s.acme, email: u.email });
            await OrgMember.update({ role: 'admin', role_id: await role_id(s.acme, 'admin') } as never, { where: { org_id: s.acme, user_id: u.id } });
            expect((await post('/v1/orgs/leave', u.token, { org_id: s.acme })).status).toBe(200);
            expect(await OrgMember.findOne({ where: { org_id: s.acme, user_id: u.id, deleted_at: null } })).toBeNull();
        });

        it('the only owner cannot leave their org', async () => {
            const u = await s.signup('soleown');
            expect((await post('/v1/orgs/leave', u.token, { org_id: u.org_id })).status).toBe(409);
        });
    });

    // ── Users (internal plane, site admin) ────────────────────────────

    describe('site-admin user management', () => {
        it('/internal/users/* refuse non-admins (403) and anonymous callers (401)', async () => {
            const target = s.user.nora;
            for (const [path, body] of [
                ['/internal/users/suspend', { user_id: target }],
                ['/internal/users/unsuspend', { user_id: target }],
                ['/internal/users/reset_password', { user_id: target }],
                ['/internal/users/set_role', { user_id: target, role: 'admin' }],
                ['/internal/users/delete', { user_id: target }],
            ] as const) {
                expect((await post(path, s.token.adam, body)).status, path).toBe(403);
                expect((await post(path, null, body)).status, path).toBe(401);
            }
        });

        it('suspend → that user’s token gets 401 → unsuspend → it works again', async () => {
            const u = await s.signup('susp');
            expect((await post('/v1/orgs/get', u.token)).status).toBe(200);
            expect((await post('/internal/users/suspend', s.token.sam, { user_id: u.id, reason: 'test' })).status).toBe(200);
            expect((await post('/v1/orgs/get', u.token)).status).toBe(401);
            expect((await post('/internal/users/unsuspend', s.token.sam, { user_id: u.id })).status).toBe(200);
            expect((await post('/v1/orgs/get', u.token)).status).toBe(200);
        });

        it('sign-in reads the stored default realm and orgs without writing any rows', async () => {
            const u = await s.signup('orgs');
            const counts = async () => ({
                orgs: await OrgMember.count({ where: { user_id: u.id } }),
                realms: await RealmMember.count({ where: { member_type: 'user', member_id: u.id } }),
                enroll_tokens: await ApiToken.count({ where: { user_id: u.id, type: 'realm' } }),
            });
            const before = await counts();
            const stored = await User.findByPk(u.id, { attributes: ['default_realm_id'], raw: true });
            const realm = await Realm.findByPk(String(stored!.default_realm_id), { attributes: ['slug', 'org_id'], raw: true });
            const realm_org = await Org.findByPk(String(realm!.org_id), { attributes: ['slug', 'display_name'], raw: true });

            const res = await post('/internal/auth/authenticate_user', null, { username: u.username, password });
            expect(res.status).toBe(200);
            expect(res.body.data.default_realm_id).toBe(String(stored!.default_realm_id));
            expect(res.body.data.default_realm_qualified).toBe(`${realm_org!.slug}.${realm!.slug}`);
            expect(res.body.data.enroll_token).toBeNull();
            expect(res.body.data.orgs).toContainEqual(expect.objectContaining({ slug: realm_org!.slug, default_realm_slug: realm!.slug }));
            expect(await counts()).toEqual(before);
        });

        it('sign-in without a stored default realm returns nulls and does not create one', async () => {
            const u = await s.signup('norealm');
            await User.update({ default_realm_id: null }, { where: { id: u.id } });
            const memberships_before = await OrgMember.count({ where: { user_id: u.id } });

            const res = await post('/internal/auth/authenticate_user', null, { username: u.username, password });
            expect(res.status).toBe(200);
            expect(res.body.data.default_realm_id).toBeNull();
            expect(res.body.data.default_realm_slug).toBeNull();
            expect(res.body.data.default_realm_qualified).toBeNull();
            expect((await User.findByPk(u.id, { attributes: ['default_realm_id'], raw: true }))?.default_realm_id).toBeNull();
            expect(await OrgMember.count({ where: { user_id: u.id } })).toBe(memberships_before);
        });

        it('cannot suspend yourself', async () => {
            expect((await post('/internal/users/suspend', s.token.sam, { user_id: s.user.sam })).status).toBe(422);
        });

        it('set_role: promote and demote; cannot demote yourself', async () => {
            const u = await s.signup('prom');
            expect((await post('/internal/users/set_role', s.token.sam, { user_id: u.id, role: 'admin' })).status).toBe(200);
            expect((await User.findOne({ where: { id: u.id }, raw: true }))?.role).toBe('admin');
            expect((await post('/internal/users/set_role', s.token.sam, { user_id: u.id, role: 'user' })).status).toBe(200);
            expect((await post('/internal/users/set_role', s.token.sam, { user_id: s.user.sam, role: 'user' })).status).toBe(422);
        });

        it('issue_session_token: admin → 200; self → 422; suspended → 403; missing → 404; non-admin → 403', async () => {
            const u = await s.signup('sess');
            expect((await post('/internal/auth/issue_session_token', s.token.sam, { user_id: u.id })).status).toBe(200);
            expect((await post('/internal/auth/issue_session_token', s.token.sam, { user_id: s.user.sam })).status).toBe(422);
            expect((await post('/internal/auth/issue_session_token', s.token.sam, { user_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
            await post('/internal/users/suspend', s.token.sam, { user_id: u.id });
            expect((await post('/internal/auth/issue_session_token', s.token.sam, { user_id: u.id })).status).toBe(403);
            expect((await post('/internal/auth/issue_session_token', s.token.adam, { user_id: s.user.mia })).status).toBe(403);
        });
    });

    describe('managing other users (/v1/users)', () => {
        it('org admin can view and update a member; not a site admin; not a stranger', async () => {
            expect((await post('/v1/users/get_by_id', s.token.adam, { user_id: s.user.mia })).status).toBe(200);
            expect((await post('/v1/users/update', s.token.adam, { user_id: s.user.mia, display_name: 'Mia A.' })).status).toBe(200);
            expect((await post('/v1/users/update', s.token.adam, { user_id: s.user.sam, display_name: 'nope' })).status).toBe(403);
            expect((await post('/v1/users/update', s.token.mia, { user_id: s.user.nora, display_name: 'nope' })).status).toBe(403);
            expect((await post('/v1/users/update', s.token.adam, { user_id: s.user.ben, display_name: 'nope' })).status).toBe(403);
        });

        it('email already in use → 409', async () => {
            const u = await s.signup('emailc');
            const other = await User.findOne({ where: { id: s.user.nora }, attributes: ['email'], raw: true });
            expect((await post('/v1/users/update', u.token, { email: other!.email })).status).toBe(409);
        });

        it('org admins cannot reset a member’s password: the route is site-admin only', async () => {
            expect((await post('/internal/users/reset_password', s.token.adam, { user_id: s.user.mia })).status).toBe(403);
        });
    });

    // ── Tokens ────────────────────────────────────────────────────────

    describe('tokens', () => {
        it('validate_token: own PAT, daemon token, garbage; needs a caller', async () => {
            const own = await post('/v1/auth/validate_token', s.token.mia, { token: s.token.mia });
            expect(own.status).toBe(200);
            expect(own.body.data).toMatchObject({ valid: true, type: 'user', user_id: s.user.mia });
            const d = await post('/v1/auth/validate_token', s.token.mia, { token: s.token.dA });
            expect(d.body.data).toMatchObject({ valid: true, realm_id: s.A1 });
            expect((await post('/v1/auth/validate_token', s.token.mia, { token: 'cliq_tok_nope' })).body.data.valid).toBe(false);
            expect((await post('/v1/auth/validate_token', null, { token: s.token.mia })).status).toBe(401);
        });

        it('generate → rotate: old token stops working, new one works; others cannot rotate it', async () => {
            const u = await s.signup('rot');
            const gen = await post('/v1/auth/generate_token', u.token, { type: 'user', name: 'rot' });
            expect(gen.status).toBe(201);
            const { token: t1, id } = gen.body.data;
            expect((await post('/v1/orgs/get', t1)).status).toBe(200);
            expect((await post('/v1/auth/rotate_token', s.token.mia, { type: 'user', token_id: id })).status).toBe(403);
            const rot = await post('/v1/auth/rotate_token', u.token, { type: 'user', token_id: id });
            expect(rot.status).toBe(200);
            expect((await post('/v1/orgs/get', t1)).status).toBe(401);
            expect((await post('/v1/orgs/get', rot.body.data.token)).status).toBe(200);
        });

        it('revoke: own token → 401 afterwards; someone else’s → 403', async () => {
            const u = await s.signup('rev');
            const gen = await post('/v1/auth/generate_token', u.token, { type: 'user', name: 'rev' });
            const { token, id } = gen.body.data;
            expect((await post('/v1/auth/revoke_token', s.token.mia, { type: 'user', token_id: id })).status).toBe(403);
            expect((await post('/v1/auth/revoke_token', u.token, { type: 'user', token_id: id })).status).toBe(200);
            expect((await post('/v1/orgs/get', token)).status).toBe(401);
            const list = await post('/v1/auth/get_tokens', u.token, { type: 'user' });
            expect((list.body.data.tokens as Array<{ id: string }>).some((t) => String(t.id) === String(id))).toBe(false);
        });

        it('fixed S24: a realm admin cannot revoke a daemon token of another realm by naming their own realm', async () => {
            const minted = await post('/v1/auth/generate_token', s.token.omar, { type: 'realm', realm_ids: [s.A1], name: 'victim' });
            expect(minted.status).toBe(201);
            const res = await post('/v1/auth/revoke_token', s.token.ben, { type: 'realm', token_id: minted.body.data.id, realm_id: s.B1 });
            expect(res.status).toBe(404); // hidden, not just refused
            expect((await post('/v1/auth/validate_token', s.token.omar, { token: minted.body.data.token })).body.data.valid).toBe(true);
        });

        it('a realm admin can revoke a daemon token of their own realm', async () => {
            const admin = await s.signup('radm');
            await RealmMember.create({ id: randomUUID(), realm_id: s.A1, member_type: 'user', member_id: admin.id, role: 'admin', created_at: Date.now() } as never);
            const minted = await post('/v1/auth/generate_token', s.token.omar, { type: 'realm', realm_ids: [s.A1], name: 'own-realm' });
            expect((await post('/v1/auth/revoke_token', admin.token, { type: 'realm', token_id: minted.body.data.id, realm_id: s.A1 })).status).toBe(200);
        });

        it('fixed S25: a restricted PAT cannot mint daemon tokens for realms outside it', async () => {
            const narrow = await post('/v1/auth/generate_token', s.token.sam, {
                type: 'user', name: 'narrow-realm', permissions: { domains: { realms: [s.A1] } },
            });
            expect(narrow.status).toBe(201);
            const res = await post('/v1/auth/generate_token', narrow.body.data.token, { type: 'realm', realm_ids: [s.A2], name: 'outside' });
            expect(res.status).toBe(403);
        });

        it('fixed B6: a PAT can be limited to one org by its UUID', async () => {
            const res = await post('/v1/auth/generate_token', s.token.adam, {
                type: 'user', name: 'org-only', permissions: { domains: { orgs: [s.acme] } },
            });
            expect(res.status).toBe(201);
            const check = await post('/v1/auth/validate_token', s.token.adam, { token: res.body.data.token });
            expect(check.body.data.permissions.domains.orgs).toEqual([s.acme]);
        });

        it('fixed S25: a restricted PAT cannot mint a token wider than itself', async () => {
            const narrow = await post('/v1/auth/generate_token', s.token.omar, {
                type: 'user', name: 'narrow', permissions: { domains: { realms: [s.A1] }, access: { runs: ['read'] } },
            });
            expect(narrow.status).toBe(201);
            const wider = await post('/v1/auth/generate_token', narrow.body.data.token, { type: 'user', name: 'wider' });
            expect(wider.status).toBe(201);
            const check = await post('/v1/auth/validate_token', s.token.omar, { token: wider.body.data.token });
            expect(check.body.data.permissions).toEqual((await post('/v1/auth/validate_token', s.token.omar, { token: narrow.body.data.token })).body.data.permissions);
        });
    });
});
