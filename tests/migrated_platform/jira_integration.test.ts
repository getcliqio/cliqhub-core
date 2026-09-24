/**
 * Slices 1.5 + 1.8 — POST /v1/integrations/jira/*.
 *
 * Contract: JIRA binding is many-to-many (realm × workspace). Each
 * (realm_id, workspace_id) pair gets its own notification_channel row,
 * secret, and rule set. Same workspace can bind into N realms, and
 * same realm can bind to N workspaces.
 *
 *  - Flag off (`ENABLE_JIRA_INTEGRATION` unset) → 404 on ALL routes.
 *  - register: requires realm_id + caller-token owner must be realm
 *    admin; 401 for bad token, 403 for non-admin, 404 for unknown
 *    realm. Idempotent per (realm_id, workspace_id): second call for
 *    same tuple returns same subscription_id, NO secret. Different
 *    (realm, workspace) tuples each get their own secret.
 *  - rotate_secret: same auth path; rotates only within the specified
 *    (realm, workspace); 404 when the pair has no binding.
 *  - list_realms: returns realms caller admins (slug order).
 *  - list: returns one row per (admin realm × JIRA binding); realms
 *    with no bindings surface as a single row with nulls.
 *  - disconnect: removes channel + rules for a specific (realm, workspace).
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hash'),
    verify_password: vi.fn().mockResolvedValue(true),
}));
import crypto from 'node:crypto';
import request from 'supertest';

import { create_migrated_test_app } from './helpers/test_app.js';
import {
    close_test_control_plane_store,
    open_test_control_plane_store,
    postgres_reachable,
} from './helpers/control_plane_store.js';
import { make_hub_bearer, stub_hub_pat_auth } from './helpers/hub_jwt.js';
import { RealmService } from '../../src/services/realm.service.js';
import {
    HubEvent,
    NotificationChannel,
    NotificationRule,
    Realm,
    RealmMember,
} from '../../src/models/index.js';
import { ApiToken } from '../../src/db/models/index.js';
import { JIRA_LIFECYCLE_EVENTS } from '../../src/services/jira_integration.service.js';

const has_postgres = await postgres_reachable();
const { app, repos } = create_migrated_test_app();
const uid = () => `jira-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function mock_user(id: number, role: 'user' | 'admin' = 'user') {
    stub_hub_pat_auth(repos);
		repos.user_repo.find_by_id.mockResolvedValue({
        id: hub_legacy_uuid(id),
        username: `user-${id}`,
        display_name: `User ${id}`,
        email: `user${id}@test.local`,
        role,
        suspended_at: null,
        suspended_reason: '',
        created_at: new Date().toISOString(),
    });
}

async function seed_pat(opts: {
    user_id: string;
    scopes?: string[];
    type?: 'user' | 'realm';
} = { user_id: hub_legacy_uuid(1) }): Promise<string> {
    const plaintext = `cliq_tok_${crypto.randomBytes(24).toString('hex')}`;
    // password.js is vi.mocked to a constant — do not use hash_password here
    // or tokens_token_hash_uidx collides on the second seed_pat in a suite.
    const token_hash = `hash-${crypto.randomBytes(16).toString('hex')}`;
    const prefix = crypto.createHash('sha256').update(plaintext).digest('hex').slice(0, 16);
    await ApiToken.create({
        id: `tok-${uid()}`,
        type: opts.type ?? 'user',
        user_id: opts.user_id,
        token_hash,
        token_prefix: prefix,
        name: `jira-test-${uid()}`,
        permissions: {},
        scopes: opts.scopes ?? [],
        revoked_at: null,
    });
    return plaintext;
}

async function make_realm_owned_by(user_id: string, slug_prefix: string): Promise<string> {
    const realm = await RealmService.create(user_id, `${slug_prefix}-${uid()}`.slice(0, 40), 'JIRA test realm');
    // RealmService.create seeds the creator as admin — no extra grant needed.
    return realm.id;
}

async function make_realm_where_user_is_operator(
    owner_id: string,
    other_id: string,
    slug_prefix: string,
): Promise<string> {
    const realm_id = await make_realm_owned_by(owner_id, slug_prefix);
    await RealmMember.create({
        id: `rm-${uid()}`,
        realm_id,
        member_type: 'user',
        member_id: other_id,
        role: 'operator',
        created_at: Date.now(),
    });
    return realm_id;
}

describe.skipIf(!has_postgres)('POST /v1/integrations/jira/*', () => {

    beforeAll(async () => {
        if (!has_postgres) return;
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
    });

    beforeEach(async () => {
        if (!has_postgres) return;
        await NotificationRule.destroy({ where: {} });
        await NotificationChannel.destroy({ where: {} });
        await HubEvent.destroy({ where: {} });
        await RealmMember.destroy({ where: {} });
        await Realm.destroy({ where: {} });
        await ApiToken.destroy({ where: {} });
        process.env.ENABLE_JIRA_INTEGRATION = '1';
    });

    afterAll(async () => {
        if (!has_postgres) return;
        delete process.env.ENABLE_JIRA_INTEGRATION;
        await close_test_control_plane_store();
    });

    // ── flag gating ─────────────────────────────────────────────────

    it('flag off → 404 on all JIRA routes', async () => {
        delete process.env.ENABLE_JIRA_INTEGRATION;
        for (const path of [
            '/v1/integrations/jira/register',
            '/v1/integrations/jira/rotate_secret',
            '/v1/integrations/jira/list_realms',
            '/v1/integrations/jira/list',
            '/v1/integrations/jira/disconnect',
        ]) {
            const res = await request(app).post(path).send({});
            expect(res.status).toBe(404);
        }
    });

    // ── register: happy paths ───────────────────────────────────────

    it('legacy PAT + admin of realm → 200 with all fields, creates channel + 7 rules', async () => {
        const token = await seed_pat({ user_id: hub_legacy_uuid(1) });
        const realm_id = await make_realm_owned_by(hub_legacy_uuid(1), 'ok');
        const workspace_id = uid();

        const res = await request(app)
            .post('/v1/integrations/jira/register')
            .send({
                api_token: token,
                realm_id,
                webhook_url: 'https://receiver.example.com/hook',
                workspace_id,
                workspace_url: 'https://scratch.atlassian.net',
            });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.subscription_id).toMatch(/./);
        expect(res.body.webhook_secret).toMatch(/^whsec_[0-9a-f]{48}$/);
        expect(res.body.realm_id).toBe(realm_id);
        expect(res.body.workspace_id).toBe(workspace_id);
        expect(res.body.cliq_user.id).toBe(hub_legacy_uuid(1));

        const channel = await NotificationChannel.findByPk(res.body.subscription_id);
        expect(channel).not.toBeNull();
        expect((channel as unknown as { realm_id: string }).realm_id).toBe(realm_id);
        expect((channel as unknown as { name: string }).name).toBe(`jira-${workspace_id}`);
        expect((channel as unknown as { secret: string }).secret).toBe(res.body.webhook_secret);

        const rules = await NotificationRule.findAll({
            where: { channel_id: res.body.subscription_id },
        });
        expect(rules.map((r) => (r as unknown as { event: string }).event).sort())
            .toEqual([...JIRA_LIFECYCLE_EVENTS].sort());
    });

    it('scoped PAT (dispatch + read:realms) → 200 same as legacy', async () => {
        const token = await seed_pat({ user_id: hub_legacy_uuid(1), scopes: ['dispatch', 'read:realms'] });
        const realm_id = await make_realm_owned_by(hub_legacy_uuid(1), 'scoped');

        const res = await request(app)
            .post('/v1/integrations/jira/register')
            .send({
                api_token: token,
                realm_id,
                webhook_url: 'https://receiver.example.com/hook',
                workspace_id: uid(),
                workspace_url: 'https://scratch.atlassian.net',
            });
        expect(res.status).toBe(200);
        expect(res.body.webhook_secret).toMatch(/^whsec_/);
    });

    // ── register: idempotency + multi-realm ─────────────────────────

    it('re-register same (realm, workspace) → same subscription_id, NO secret', async () => {
        const token = await seed_pat({ user_id: hub_legacy_uuid(1) });
        const realm_id = await make_realm_owned_by(hub_legacy_uuid(1), 'idemp');
        const workspace_id = uid();
        const body = {
            api_token: token,
            realm_id,
            webhook_url: 'https://receiver.example.com/hook',
            workspace_id,
            workspace_url: 'https://scratch.atlassian.net',
        };

        const first = await request(app).post('/v1/integrations/jira/register').send(body);
        expect(first.status).toBe(200);
        const first_secret = first.body.webhook_secret as string;

        const second = await request(app).post('/v1/integrations/jira/register').send(body);
        expect(second.status).toBe(200);
        expect(second.body.subscription_id).toBe(first.body.subscription_id);
        expect(second.body.webhook_secret).toBeUndefined();

        const channel = await NotificationChannel.findByPk(first.body.subscription_id);
        expect((channel as unknown as { secret: string }).secret).toBe(first_secret);
    });

    it('same workspace can bind into multiple realms — each gets its own channel + secret (slice 1.8)', async () => {
        // Per slice 1.8, the runtime model is many-to-many: one JIRA
        // workspace can be routed into N realms in the same account.
        // Each (realm, workspace) pair gets its own notification_channel
        // row, its own webhook secret, and its own set of 7 lifecycle
        // rules. Events emitted for realm A never leak into realm B's
        // JIRA install (they're two independent subscriptions).
        const token = await seed_pat({ user_id: hub_legacy_uuid(1) });
        const realm_a = await make_realm_owned_by(hub_legacy_uuid(1), 'multi-a');
        const realm_b = await make_realm_owned_by(hub_legacy_uuid(1), 'multi-b');
        const workspace_id = uid();
        const common = {
            api_token: token,
            webhook_url: 'https://receiver.example.com/hook',
            workspace_id,
            workspace_url: 'https://scratch.atlassian.net',
        };

        const a = await request(app).post('/v1/integrations/jira/register')
            .send({ ...common, realm_id: realm_a });
        expect(a.status).toBe(200);
        expect(a.body.webhook_secret).toMatch(/^whsec_/);
        expect(a.body.realm_id).toBe(realm_a);

        const b = await request(app).post('/v1/integrations/jira/register')
            .send({ ...common, realm_id: realm_b });
        expect(b.status).toBe(200);
        expect(b.body.webhook_secret).toMatch(/^whsec_/);
        expect(b.body.realm_id).toBe(realm_b);

        // Two independent channels with independent secrets.
        expect(a.body.subscription_id).not.toBe(b.body.subscription_id);
        expect(a.body.webhook_secret).not.toBe(b.body.webhook_secret);

        // Both channels persist with correct realm scoping.
        const channels = await NotificationChannel.findAll({
            where: { name: `jira-${workspace_id}` },
        });
        expect(channels).toHaveLength(2);
        const realm_ids = channels
            .map((c) => (c as unknown as { realm_id: string }).realm_id)
            .sort();
        expect(realm_ids).toEqual([realm_a, realm_b].sort());
    });

    it('one realm can bind two different workspaces (separate channels)', async () => {
        const token = await seed_pat({ user_id: hub_legacy_uuid(1) });
        const realm_id = await make_realm_owned_by(hub_legacy_uuid(1), 'twoworkspaces');
        const w_a = uid();
        const w_b = uid();

        const a = await request(app).post('/v1/integrations/jira/register').send({
            api_token: token, realm_id, workspace_id: w_a,
            webhook_url: 'https://a.example.com/hook',
            workspace_url: 'https://a.atlassian.net',
        });
        const b = await request(app).post('/v1/integrations/jira/register').send({
            api_token: token, realm_id, workspace_id: w_b,
            webhook_url: 'https://b.example.com/hook',
            workspace_url: 'https://b.atlassian.net',
        });
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(a.body.subscription_id).not.toBe(b.body.subscription_id);
    });

    // ── register: auth failure surfaces ─────────────────────────────

    it('bogus token → 401', async () => {
        const realm_id = await make_realm_owned_by(hub_legacy_uuid(1), 'bogus');
        const res = await request(app).post('/v1/integrations/jira/register').send({
            api_token: `cliq_tok_${crypto.randomBytes(24).toString('hex')}`,
            realm_id,
            webhook_url: 'https://x.example.com/hook',
            workspace_id: uid(),
            workspace_url: 'https://x.atlassian.net',
        });
        expect(res.status).toBe(401);
    });

    it('scoped PAT missing read:realms → 401', async () => {
        const token = await seed_pat({ user_id: hub_legacy_uuid(1), scopes: ['dispatch'] });
        const realm_id = await make_realm_owned_by(hub_legacy_uuid(1), 'noscope');
        const res = await request(app).post('/v1/integrations/jira/register').send({
            api_token: token, realm_id,
            webhook_url: 'https://x.example.com/hook',
            workspace_id: uid(),
            workspace_url: 'https://x.atlassian.net',
        });
        expect(res.status).toBe(401);
    });

    it('non-admin of target realm → 403', async () => {
        // User 2 is only an operator, not admin, of realm owned by user 1.
        const token = await seed_pat({ user_id: hub_legacy_uuid(2) });
        const realm_id = await make_realm_where_user_is_operator(hub_legacy_uuid(1), hub_legacy_uuid(2), 'nonadmin');
        const res = await request(app).post('/v1/integrations/jira/register').send({
            api_token: token, realm_id,
            webhook_url: 'https://x.example.com/hook',
            workspace_id: uid(),
            workspace_url: 'https://x.atlassian.net',
        });
        expect(res.status).toBe(403);
    });

    it('unknown realm → 404', async () => {
        const token = await seed_pat({ user_id: hub_legacy_uuid(1) });
        const res = await request(app).post('/v1/integrations/jira/register').send({
            api_token: token,
            realm_id: 'realm-does-not-exist',
            webhook_url: 'https://x.example.com/hook',
            workspace_id: uid(),
            workspace_url: 'https://x.atlassian.net',
        });
        expect(res.status).toBe(404);
    });

    // ── rotate_secret ───────────────────────────────────────────────

    it('rotate_secret → new whsec_, differs from register secret', async () => {
        const token = await seed_pat({ user_id: hub_legacy_uuid(1) });
        const realm_id = await make_realm_owned_by(hub_legacy_uuid(1), 'rot');
        const workspace_id = uid();
        const reg = await request(app).post('/v1/integrations/jira/register').send({
            api_token: token, realm_id, workspace_id,
            webhook_url: 'https://x.example.com/hook',
            workspace_url: 'https://x.atlassian.net',
        });
        expect(reg.status).toBe(200);
        const orig = reg.body.webhook_secret as string;

        const rot = await request(app).post('/v1/integrations/jira/rotate_secret').send({
            api_token: token, realm_id, workspace_id,
        });
        expect(rot.status).toBe(200);
        expect(rot.body.secret).toMatch(/^whsec_/);
        expect(rot.body.secret).not.toBe(orig);
    });

    it('rotate for (realm, workspace) with no binding → 404', async () => {
        const token = await seed_pat({ user_id: hub_legacy_uuid(1) });
        const realm_id = await make_realm_owned_by(hub_legacy_uuid(1), 'rotmiss');
        const rot = await request(app).post('/v1/integrations/jira/rotate_secret').send({
            api_token: token, realm_id, workspace_id: 'never-bound',
        });
        expect(rot.status).toBe(404);
    });

    it('rotate: non-admin → 403 (does not leak "channel exists" via 404 vs 403 timing)', async () => {
        const owner_token = await seed_pat({ user_id: hub_legacy_uuid(1) });
        const other_token = await seed_pat({ user_id: hub_legacy_uuid(2) });
        const realm_id = await make_realm_where_user_is_operator(hub_legacy_uuid(1), hub_legacy_uuid(2), 'rotperm');
        const workspace_id = uid();

        const reg = await request(app).post('/v1/integrations/jira/register').send({
            api_token: owner_token, realm_id, workspace_id,
            webhook_url: 'https://x.example.com/hook',
            workspace_url: 'https://x.atlassian.net',
        });
        expect(reg.status).toBe(200);

        const rot = await request(app).post('/v1/integrations/jira/rotate_secret').send({
            api_token: other_token, realm_id, workspace_id,
        });
        expect(rot.status).toBe(403);
    });

    // ── list_realms ─────────────────────────────────────────────────

    it('list_realms returns realms caller admins in slug order', async () => {
        const token = await seed_pat({ user_id: hub_legacy_uuid(1) });
        // Two realms owned; one where user is only operator (should NOT appear).
        const admin_a = await make_realm_owned_by(hub_legacy_uuid(1), 'aaaa');
        const admin_b = await make_realm_owned_by(hub_legacy_uuid(1), 'bbbb');
        const op_only = await make_realm_where_user_is_operator(hub_legacy_uuid(2), hub_legacy_uuid(1), 'cccc');

        const res = await request(app).post('/v1/integrations/jira/list_realms').send({
            api_token: token,
        });
        expect(res.status).toBe(200);
        const ids = (res.body.realms as Array<{ id: string; slug: string }>).map((r) => r.id);
        expect(ids).toContain(admin_a);
        expect(ids).toContain(admin_b);
        expect(ids).not.toContain(op_only);
        // Slug order.
        const slugs = (res.body.realms as Array<{ slug: string }>).map((r) => r.slug);
        expect([...slugs]).toEqual([...slugs].sort());
    });

    // ── list ────────────────────────────────────────────────────────

    it('list returns one row per (admin realm × JIRA binding); unbound realms surface as a single null row', async () => {
        const token = await seed_pat({ user_id: hub_legacy_uuid(1) });
        const bound = await make_realm_owned_by(hub_legacy_uuid(1), 'zzz-bound');
        const unbound = await make_realm_owned_by(hub_legacy_uuid(1), 'yyy-unbound');
        const workspace_id = uid();

        await request(app).post('/v1/integrations/jira/register').send({
            api_token: token, realm_id: bound, workspace_id,
            webhook_url: 'https://x.example.com/hook',
            workspace_url: 'https://x.atlassian.net',
        });

        const res = await request(app).post('/v1/integrations/jira/list').send({
            api_token: token,
        });
        expect(res.status).toBe(200);
        const rows = res.body.bindings as Array<{
            realm_id: string;
            channel_id: string | null;
            workspace_id: string | null;
            connected_at: number | null;
        }>;

        const bound_rows = rows.filter((r) => r.realm_id === bound);
        const unbound_rows = rows.filter((r) => r.realm_id === unbound);
        expect(bound_rows).toHaveLength(1);
        expect(bound_rows[0].channel_id).not.toBeNull();
        expect(bound_rows[0].workspace_id).toBe(workspace_id);
        expect(typeof bound_rows[0].connected_at).toBe('number');

        expect(unbound_rows).toHaveLength(1);
        expect(unbound_rows[0].channel_id).toBeNull();
        expect(unbound_rows[0].workspace_id).toBeNull();
        expect(unbound_rows[0].connected_at).toBeNull();
    });

    it('list emits N rows for a realm bound to N workspaces (slice 1.8 multi-binding)', async () => {
        const token = await seed_pat({ user_id: hub_legacy_uuid(1) });
        const realm_id = await make_realm_owned_by(hub_legacy_uuid(1), 'multi-list');
        const w_a = uid();
        const w_b = uid();

        for (const workspace_id of [w_a, w_b]) {
            await request(app).post('/v1/integrations/jira/register').send({
                api_token: token, realm_id, workspace_id,
                webhook_url: `https://${workspace_id}.example.com/hook`,
                workspace_url: `https://${workspace_id}.atlassian.net`,
            });
        }

        const res = await request(app).post('/v1/integrations/jira/list').send({
            api_token: token,
        });
        expect(res.status).toBe(200);
        const rows = (res.body.bindings as Array<{
            realm_id: string; workspace_id: string | null;
        }>).filter((r) => r.realm_id === realm_id);
        const workspace_ids = rows.map((r) => r.workspace_id).sort();
        expect(workspace_ids).toEqual([w_a, w_b].sort());
    });

    // ── disconnect ──────────────────────────────────────────────────

    it('disconnect removes channel + rules; second call returns removed=false', async () => {
        const token = await seed_pat({ user_id: hub_legacy_uuid(1) });
        const realm_id = await make_realm_owned_by(hub_legacy_uuid(1), 'disc');
        const workspace_id = uid();
        const reg = await request(app).post('/v1/integrations/jira/register').send({
            api_token: token, realm_id, workspace_id,
            webhook_url: 'https://x.example.com/hook',
            workspace_url: 'https://x.atlassian.net',
        });
        const channel_id = reg.body.subscription_id as string;

        const first = await request(app).post('/v1/integrations/jira/disconnect').send({
            api_token: token, realm_id, workspace_id,
        });
        expect(first.status).toBe(200);
        expect(first.body.removed).toBe(true);

        expect(await NotificationChannel.findByPk(channel_id)).toBeNull();
        expect(await NotificationRule.count({ where: { channel_id } })).toBe(0);

        const second = await request(app).post('/v1/integrations/jira/disconnect').send({
            api_token: token, realm_id, workspace_id,
        });
        expect(second.status).toBe(200);
        expect(second.body.removed).toBe(false);
    });

    // ── session (JWT) auth — SPA callers ────────────────────────────

    it('session JWT works for list_realms (no api_token body needed)', async () => {
        mock_user(1);
        // Realm admin user_id=1 with a fresh realm.
        const realm_id = await make_realm_owned_by(hub_legacy_uuid(1), 'sess-lr');
        const bearer = make_hub_bearer({ user_id: hub_legacy_uuid(1), username: 'migrated-platform-user' });
        const res = await request(app)
            .post('/v1/integrations/jira/list_realms')
            .set('Authorization', bearer)
            .send({});
        expect(res.status).toBe(200);
        const ids = (res.body.realms as Array<{ id: string }>).map((r) => r.id);
        expect(ids).toContain(realm_id);
    });

    it('session JWT works for register + list + rotate + disconnect (no api_token body)', async () => {
        mock_user(1);
        const realm_id = await make_realm_owned_by(hub_legacy_uuid(1), 'sess-full');
        const workspace_id = uid();
        const bearer = make_hub_bearer({ user_id: hub_legacy_uuid(1), username: 'migrated-platform-user' });

        const reg = await request(app)
            .post('/v1/integrations/jira/register')
            .set('Authorization', bearer)
            .send({
                realm_id, workspace_id,
                webhook_url: 'https://x.example.com/hook',
                workspace_url: 'https://x.atlassian.net',
            });
        expect(reg.status).toBe(200);
        expect(reg.body.webhook_secret).toMatch(/^whsec_/);

        const list = await request(app)
            .post('/v1/integrations/jira/list')
            .set('Authorization', bearer)
            .send({});
        expect(list.status).toBe(200);
        expect(list.body.bindings.some((b: { realm_id: string }) => b.realm_id === realm_id))
            .toBe(true);

        const rot = await request(app)
            .post('/v1/integrations/jira/rotate_secret')
            .set('Authorization', bearer)
            .send({ realm_id, workspace_id });
        expect(rot.status).toBe(200);
        expect(rot.body.secret).toMatch(/^whsec_/);
        expect(rot.body.secret).not.toBe(reg.body.webhook_secret);

        const disc = await request(app)
            .post('/v1/integrations/jira/disconnect')
            .set('Authorization', bearer)
            .send({ realm_id, workspace_id });
        expect(disc.status).toBe(200);
        expect(disc.body.removed).toBe(true);
    });

    it('no session + no api_token → 401', async () => {
        // Note: register schema requires realm_id/workspace_id, so send
        // a well-formed body sans api_token to isolate the auth failure.
        const res = await request(app)
            .post('/v1/integrations/jira/list_realms')
            .send({});
        expect(res.status).toBe(401);
    });

    // ── disconnect: non-admin ──────────────────────────────────────

    it('disconnect: non-admin → 403', async () => {
        const owner_token = await seed_pat({ user_id: hub_legacy_uuid(1) });
        const other_token = await seed_pat({ user_id: hub_legacy_uuid(2) });
        const realm_id = await make_realm_where_user_is_operator(hub_legacy_uuid(1), hub_legacy_uuid(2), 'discperm');
        const workspace_id = uid();
        await request(app).post('/v1/integrations/jira/register').send({
            api_token: owner_token, realm_id, workspace_id,
            webhook_url: 'https://x.example.com/hook',
            workspace_url: 'https://x.atlassian.net',
        });

        const res = await request(app).post('/v1/integrations/jira/disconnect').send({
            api_token: other_token, realm_id, workspace_id,
        });
        expect(res.status).toBe(403);
    });
});
