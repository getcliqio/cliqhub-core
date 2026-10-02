/**
 * users/delete over HTTP on live Postgres (full production app, route policy enforced).
 *
 *   1. A delete is soft: the user row and their account org stay (deleted_at
 *      set, the account org's realms soft-deleted with their slugs), other
 *      memberships become former memberships, scope and realm memberships go,
 *      tokens and pending invites they sent are revoked; history is kept.
 *   2. The name stays taken: a new signup with the same username or email
 *      gets 409 deleted.
 *   3. Each refusal answers 409 and changes nothing: authored team, team in the
 *      personal org's scope, owner of another org (owns_orgs), other members in
 *      the personal org, a daemon / a run in progress / an active dispatch job
 *      in a personal realm.
 *   4. Audit rows outlive the admin who wrote them.
 *   5. The boot repair finds nothing to do afterwards (and is idempotent).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { Op, QueryTypes } from 'sequelize';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { accept_invite_url } from '../helpers/invite_links.js';
import { use_test_link_env } from '../helpers/link_env.js';
import { remove_org_rows } from '../helpers/remove_org_rows.js';

const has_postgres = await postgres_reachable();
const password = 'password123';

describe.skipIf(!has_postgres)('users/delete (live Postgres)', () => {
    let app: Express;
    let M: typeof import('../../src/models/index.js');
    let sq: import('sequelize').Sequelize;
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
    const names: string[] = [];
    let root: { id: string; token: string };

    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        const r = request(app).post(path).send(body);
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    const name = (label: string) => { const n = `ud${label}${stamp}`.slice(0, 32).toLowerCase(); names.push(n); return n; };

    async function signup(username: string) {
        const res = await post('/internal/auth/signup', null, { username, email: `${username}@ud.test`, password });
        if (res.status !== 200) throw new Error(`signup ${username}: ${res.status} ${JSON.stringify(res.body)}`);
        const id = String(res.body.data.user.id);
        const org = await M.Org.findOne({ where: { slug: username }, attributes: ['id'], raw: true });
        return { id, token: String(res.body.data.token), username, org_id: String(org!.id) };
    }
    const delete_user = (user_id: string) => post('/internal/users/delete', root.token, { user_id });

    /** Personal realms of an org (alive). */
    const alive_realms = async (org_id: string) =>
        (await M.Realm.findAll({ where: { org_id, deleted: false }, attributes: ['id'], raw: true })).map((r) => String(r.id));

    /** What a refused delete must leave untouched. */
    async function footprint(u: { id: string; username: string; org_id: string }) {
        return {
            user: await M.User.count({ where: { id: u.id, deleted_at: null } }),
            org: await M.Org.count({ where: { id: u.org_id, deleted_at: null } }),
            roles: await M.OrgRole.count({ where: { org_id: u.org_id } }),
            members: await M.OrgMember.count({ where: { user_id: u.id, deleted_at: null } }),
            scopes: await M.Scope.count({ where: { org_id: u.org_id } }),
            realms: (await alive_realms(u.org_id)).length,
            tokens: await M.ApiToken.count({ where: { user_id: u.id, revoked_at: null } }),
        };
    }

    async function expect_refused(u: { id: string; username: string; org_id: string }, match: RegExp, code = 'conflict') {
        const before = await footprint(u);
        const res = await delete_user(u.id);
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(res.body.code ?? res.body.error?.code).toBe(code);
        expect(JSON.stringify(res.body)).toMatch(match);
        expect(await footprint(u)).toEqual(before);
    }

    let restore_link_env: () => void;

    beforeAll(async () => {
        restore_link_env = use_test_link_env();
        const live = await open_live_hub_app();
        app = live.app;
        M = await import('../../src/models/index.js');
        sq = (await import('../../src/db/sequelize.js')).get_sequelize();
        root = await signup(name('root'));
        await M.User.update({ role: 'admin' }, { where: { id: root.id } });
    }, 300_000);

    afterAll(async () => {
        // Remove the rows the test users left (soft-deleted ones included).
        const users = await M?.User.findAll({ where: { username: { [Op.in]: names } }, attributes: ['id', 'username'], raw: true }) ?? [];
        for (const u of users) {
            try {
                await sq.transaction(async (t) => {
                    const orgs = await M.Org.findAll({ where: { [Op.or]: [{ slug: u.username }, { owner_id: u.id }] }, attributes: ['id'], raw: true, transaction: t });
                    for (const o of orgs) await remove_org_rows({ id: String(o.id) }, t);
                    await M.Scope.destroy({ where: { owner_id: u.id }, transaction: t });
                    for (const model of [M.ScopeMember, M.OrgMember, M.ApiToken, M.Draft]) {
                        await (model as unknown as { destroy: (o: object) => Promise<number> }).destroy({ where: { user_id: u.id }, transaction: t });
                    }
                    await M.User.destroy({ where: { id: u.id }, transaction: t });
                });
            } catch { /* best effort */ }
        }
        await close_live_hub_app();
        restore_link_env?.();
    }, 300_000);

    // ── 1 + 2. soft delete, name kept ───────────────────────────────────

    it('soft-deletes the user and their account org, revokes access, and keeps history', async () => {
        const u = await signup(name('full'));
        const other = await signup(name('host'));
        // A membership in another org and its realm, a draft, a pending invite sent.
        await M.OrgMember.create({ org_id: other.org_id, user_id: u.id, role: 'member' } as never);
        const host_realm = (await alive_realms(other.org_id))[0];
        await M.RealmMember.create({ id: randomUUID(), realm_id: host_realm, member_type: 'user', member_id: u.id, role: 'member', created_at: Date.now() } as never);
        await M.Draft.create({ user_id: u.id } as never);
        const invite = randomUUID();
        await M.AccountInvite.create({ id: invite, org_id: other.org_id, email: `x${stamp}@ud.test`, invited_by: u.id, token_hash: `h${stamp}`, role: 'member', status: 'pending', expires_at: new Date(Date.now() + 86_400_000) } as never);
        await post('/v1/orgs/get', u.token); // a login-path touch: ensure_personal_realm runs again

        const realm_ids = await alive_realms(u.org_id);
        expect(realm_ids.length).toBeGreaterThan(0);
        const realm_slugs = (await M.Realm.findAll({ where: { id: { [Op.in]: realm_ids } }, attributes: ['slug'], raw: true })).map((r) => r.slug).sort();

        const res = await delete_user(u.id);
        expect(res.status, JSON.stringify(res.body)).toBe(200);

        const user = (await M.User.findByPk(u.id, { raw: true }))!;
        expect(user.deleted_at).not.toBeNull();
        expect(user.username).toBe(u.username);
        const org = (await M.Org.findByPk(u.org_id, { raw: true }))!;
        expect(org).toMatchObject({ status: 'deleted', slug: u.username });
        // The account org's realms are soft-deleted with their slugs kept (a reactivation brings them back).
        const realms = await M.Realm.findAll({ where: { id: { [Op.in]: realm_ids } }, attributes: ['deleted', 'slug'], raw: true });
        expect(realms.every((r) => r.deleted)).toBe(true);
        expect(realms.map((r) => r.slug).sort()).toEqual(realm_slugs);
        // Memberships: org rows marked deleted, realm and scope rows gone; tokens and sent invites revoked.
        expect(await M.OrgMember.count({ where: { user_id: u.id, deleted_at: null } })).toBe(0);
        expect(await M.OrgMember.count({ where: { org_id: other.org_id, user_id: u.id } })).toBe(1);
        expect(await M.RealmMember.count({ where: { member_type: 'user', member_id: u.id } })).toBe(0);
        expect(await M.ScopeMember.count({ where: { user_id: u.id } })).toBe(0);
        expect(await M.ApiToken.count({ where: { user_id: u.id, revoked_at: null } })).toBe(0);
        expect((await M.AccountInvite.findByPk(invite, { raw: true }))!.status).toBe('revoked');
        // Kept: drafts, scopes, the other org.
        expect(await M.Draft.count({ where: { user_id: u.id } })).toBe(1);
        expect(await M.Scope.count({ where: { slug: u.username } })).toBe(1);
        expect(await M.OrgMember.count({ where: { org_id: other.org_id, user_id: other.id, deleted_at: null } })).toBe(1);
        // The old token no longer works.
        expect((await post('/v1/orgs/get', u.token)).status).toBe(401);
        expect((await post('/internal/auth/authenticate_user', null, { username: u.username, password })).body.error.code).toBe('account_deleted');
        expect((await delete_user(other.id)).status).toBe(200);
    });

    it('keeps the name: a new signup with the same username or email gets 409 deleted', async () => {
        const u = await signup(name('again'));
        expect((await delete_user(u.id)).status).toBe(200);
        for (const body of [
            { username: u.username, email: `fresh${stamp}@ud.test`, password },
            { username: name('fresh'), email: `${u.username}@ud.test`, password },
        ]) {
            const res = await post('/internal/auth/signup', null, body);
            expect(res.status, JSON.stringify(res.body)).toBe(409);
            expect(res.body.error).toMatchObject({ code: 'deleted', details: { kind: 'user', id: u.id, was_active: true } });
        }
        expect(await M.Scope.count({ where: { slug: u.username } })).toBe(1);
    });

    // ── 3. refusals ─────────────────────────────────────────────────────

    it('refuses while the user authored a team', async () => {
        const u = await signup(name('auth'));
        const team = randomUUID();
        await M.Team.create({ id: team, name: `udt${stamp}`, scope: 'cliq', visibility: 'private', listed: 0, author_id: u.id } as never);
        await expect_refused(u, /authored 1 team/);
        await M.Team.destroy({ where: { id: team } });
        expect((await delete_user(u.id)).status).toBe(200);
    });

    it('refuses while a team sits in the personal org scope', async () => {
        const u = await signup(name('scp'));
        const team = randomUUID();
        await M.Team.create({ id: team, name: `udt2${stamp}`, scope: u.username, visibility: 'private', listed: 0, author_id: root.id } as never);
        await expect_refused(u, /team\(s\) in scope/);
        await M.Team.destroy({ where: { id: team } });
        expect((await delete_user(u.id)).status).toBe(200);
    });

    it('refuses with owns_orgs while the user owns another org', async () => {
        const u = await signup(name('own'));
        const slug = name('org');
        const res = await post('/internal/orgs/new', root.token, { slug, owner: { user_id: u.id } });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        await accept_invite_url(app, u.token, res.body.data.owner_invite.invite_url);
        await expect_refused(u, new RegExp(`"orgs":\\[\\{"slug":"${slug}"\\}\\]`), 'owns_orgs');
        const org = await M.Org.findOne({ where: { slug }, attributes: ['id'], raw: true });
        expect((await post('/internal/orgs/delete', root.token, { org_id: org!.id })).status).toBe(200);
        expect((await delete_user(u.id)).status).toBe(200);
    });

    it('refuses while the personal org has other members', async () => {
        const u = await signup(name('mem'));
        const m = await signup(name('mem2'));
        await M.OrgMember.create({ org_id: u.org_id, user_id: m.id, role: 'member' } as never);
        await expect_refused(u, /1 other member/);
        await M.OrgMember.destroy({ where: { org_id: u.org_id, user_id: m.id } });
        expect((await delete_user(u.id)).status).toBe(200);
        expect((await delete_user(m.id)).status).toBe(200);
    });

    it('refuses while a personal realm has a daemon, a run in progress or an active dispatch job', async () => {
        const u = await signup(name('rlm'));
        const [realm_id] = await alive_realms(u.org_id);
        const now = Date.now();

        const daemon = randomUUID();
        await M.RealmMember.create({ id: daemon, realm_id, member_type: 'daemon', member_id: `udd${stamp}`, role: 'operator', created_at: now } as never);
        await expect_refused(u, /daemon/);
        await M.RealmMember.destroy({ where: { id: daemon } });

        const run_id = `udr${stamp}`;
        const machine = `udd${stamp}`;
        await M.Daemon.create({ id: machine, api_key_hash: 'x', created_at: now, last_registered_at: now } as never);
        await M.Workspace.create({ id: `udw${stamp}`, path: `/tmp/udw${stamp}`, daemon_id: machine, created_at: now, updated_at: now } as never);
        await M.Run.create({ run_id, workspace_id: `udw${stamp}`, team_id: 'ud-team', started_at: now, realm_id, org_id: u.org_id, state: 'running' } as never);
        await expect_refused(u, /run\(s\) in progress/);
        await M.Run.update({ state: 'completed' } as never, { where: { run_id } });

        const job = randomUUID();
        await M.RealmDispatchQueue.create({ id: job, realm_id, kind: 'run', submitted_by: u.id, submitted_at: now, created_at: now, updated_at: now } as never);
        await expect_refused(u, /dispatch job/);
        await M.RealmDispatchQueue.update({ status: 'completed' } as never, { where: { id: job } });

        expect((await delete_user(u.id)).status).toBe(200);
        // History stays: the run and the job still point at the (soft-deleted) realm.
        expect(await M.Run.count({ where: { run_id, realm_id } })).toBe(1);
        expect(await M.RealmDispatchQueue.count({ where: { id: job } })).toBe(1);
        await M.Run.destroy({ where: { run_id } });
        await M.RealmDispatchQueue.destroy({ where: { id: job } });
        await M.Workspace.destroy({ where: { id: `udw${stamp}` } });
        await M.Daemon.destroy({ where: { id: machine } });
    });

    // ── 4. history ──────────────────────────────────────────────────────

    it('keeps the audit rows a deleted admin wrote', async () => {
        const a = await signup(name('adm'));
        await M.User.update({ role: 'admin' }, { where: { id: a.id } });
        const v = await signup(name('vic'));
        expect((await post('/internal/users/suspend', a.token, { user_id: v.id, reason: 'audit test' })).status).toBe(200);
        const written = await M.AuditLog.count({ where: { admin_id: a.id } });
        expect(written).toBeGreaterThan(0);

        expect((await delete_user(a.id)).status).toBe(200);
        expect(await M.AuditLog.count({ where: { admin_id: a.id } })).toBe(written);
        expect(await M.AuditLog.count({ where: { action: 'user.delete', target_id: a.id } })).toBe(1);
        expect((await delete_user(v.id)).status).toBe(200);
    });

    // ── 5. boot repair ──────────────────────────────────────────────────

    it('leaves nothing for the boot repair, which is idempotent', async () => {
        const u = await signup(name('rep'));
        expect((await delete_user(u.id)).status).toBe(200);
        const { repair_namespace_orphans } = await import('../../src/models/migrations/migrate_namespace_orphans.js');
        const first = await repair_namespace_orphans(sq);
        const second = await repair_namespace_orphans(sq);
        const ours = (r: typeof first) => JSON.stringify(r).includes(stamp);
        expect(ours(first)).toBe(false);
        expect(second.user_scopes_removed).toEqual([]);
        expect(second.org_scopes_removed).toEqual([]);
        expect(second.org_scopes_created).toEqual([]);
    });
});
