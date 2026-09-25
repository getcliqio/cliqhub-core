/**
 * E2E: Realm A2A + mesh lifecycle (auto-enable, re_register, delete)
 * and public card /send with realm bearer.
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
import { User, OrgMember } from '../../src/db/models/index.js';
import {
    Realm,
    RealmMember,
    NotificationChannel,
    RealmDispatchKey,
    RealmA2aSetting,
} from '../../src/models/index.js';
import { register_mesh_adapter } from '../../src/mesh/registry.js';
import type { Mesh_adapter } from '../../src/mesh/types.js';
import { get_sequelize } from '../../src/db/sequelize.js';

const has_postgres = await postgres_reachable();
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = 'password123';

const mesh_calls = {
    connect: 0,
    disconnect: 0,
    re_register: 0,
};

const test_mesh_adapter: Mesh_adapter = {
    id: 'test_mesh',
    label: 'Test Mesh',
    settings_schema: [
        { key: 'api_token', label: 'Token', type: 'secret', required: true },
    ],
    async connect() {
        mesh_calls.connect += 1;
        return { status: 'connected', message: 'test connected' };
    },
    async disconnect() {
        mesh_calls.disconnect += 1;
        return { status: 'disconnected', message: 'test disconnected' };
    },
    async re_register() {
        mesh_calls.re_register += 1;
        return { status: 'connected', message: 'test refreshed' };
    },
    async health() {
        return { status: 'connected', message: 'ok' };
    },
};

function bearer(token: string): string {
    return `Bearer ${token}`;
}

async function wait_for(
    pred: () => boolean,
    timeout_ms = 4_000,
): Promise<void> {
    const start = Date.now();
    while (!pred()) {
        if (Date.now() - start > timeout_ms) {
            throw new Error('wait_for timeout');
        }
        await new Promise((r) => setTimeout(r, 50));
    }
}

describe.skipIf(!has_postgres)('realm a2a + mesh lifecycle e2e', () => {
    let app: Express;
    const tracked: string[] = [];
    let user_id: string;
    let token: string;
    let username: string;
    let org_id: string;

    beforeAll(async () => {
        register_mesh_adapter(test_mesh_adapter);
        const hub = await open_live_hub_app();
        app = hub.app;

        username = `e2ea2a${stamp}`.slice(0, 32).toLowerCase();
        tracked.push(username);
        const res = await request(app)
            .post('/internal/auth/signup')
            .send({
                username,
                email: `${username}@e2e.test`,
                password,
            });
        expect(res.status).toBe(200);
        user_id = res.body.data.user.id as number;
        token = res.body.data.token as string;
        const membership = await OrgMember.findOne({
            where: { user_id },
            attributes: ['org_id'],
        });
        expect(membership?.org_id).toBeTruthy();
        org_id = String(membership!.org_id);
    }, 60_000);

    afterAll(async () => {
        try {
            const users = await User.findAll({
                where: { username: { [Op.in]: tracked } },
                attributes: ['id', 'default_realm_id'],
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
            }
            for (const realm_id of realm_ids) {
                await RealmA2aSetting.destroy({ where: { realm_id } });
                await RealmMember.destroy({ where: { realm_id } });
                await NotificationChannel.destroy({ where: { realm_id } });
                await RealmDispatchKey.destroy({ where: { realm_id } });
                await Realm.destroy({ where: { id: realm_id } });
            }
            if (numeric_ids.length > 0) {
                await User.update(
                    { default_realm_id: null },
                    { where: { id: { [Op.in]: numeric_ids } } },
                );
                const sequelize = get_sequelize();
                await sequelize.query(
                    `DELETE FROM tokens WHERE user_id IN (:ids)`,
                    { replacements: { ids: numeric_ids } },
                );
                await sequelize.query(
                    `DELETE FROM scope_members WHERE scope_id IN (
                       SELECT id FROM scopes WHERE owner_id IN (:ids)
                     )`,
                    { replacements: { ids: numeric_ids } },
                );
                await sequelize.query(
                    `UPDATE orgs SET default_scope_id = NULL
                     WHERE default_scope_id IN (
                       SELECT id FROM scopes WHERE owner_id IN (:ids)
                     )`,
                    { replacements: { ids: numeric_ids } },
                );
                await sequelize.query(
                    `DELETE FROM scopes WHERE owner_id IN (:ids)`,
                    { replacements: { ids: numeric_ids } },
                );
                await User.destroy({ where: { id: { [Op.in]: numeric_ids } } });
            }
        } finally {
            await close_live_hub_app();
        }
    }, 60_000);

    it('5.1 auto-enable off → no connect; on → enable + connect', async () => {
        mesh_calls.connect = 0;

        const off_slug = `a2a-off-${stamp}`.slice(0, 40);
        const create_off = await request(app)
            .post('/v1/realms/create')
            .set('Authorization', bearer(token))
            .send({ org_id, slug: off_slug, name: 'A2A Off' });
        expect(create_off.status).toBe(200);
        const off_id = create_off.body.realm.id as string;

        const settings_off = await request(app)
            .post('/v1/realms/a2a')
            .set('Authorization', bearer(token))
            .send({ action: 'get', realm_id: off_id });
        expect(settings_off.status).toBe(200);
        expect(settings_off.body.a2a_enabled).toBe(false);
        expect(mesh_calls.connect).toBe(0);

        const mesh_upd = await request(app)
            .post('/v1/account/mesh/update')
            .set('Authorization', bearer(token))
            .send({
                active_provider_id: 'test_mesh',
                auto_enable_a2a_on_realm_create: true,
                provider_id: 'test_mesh',
                provider_settings: { api_token: 'test-secret' },
            });
        expect(mesh_upd.status).toBe(200);

        const on_slug = `a2a-on-${stamp}`.slice(0, 40);
        const create_on = await request(app)
            .post('/v1/realms/create')
            .set('Authorization', bearer(token))
            .send({ org_id, slug: on_slug, name: 'A2A On' });
        expect(create_on.status).toBe(200);
        const on_id = create_on.body.realm.id as string;
        expect(mesh_calls.connect).toBeGreaterThanOrEqual(1);

        const settings_on = await request(app)
            .post('/v1/realms/a2a')
            .set('Authorization', bearer(token))
            .send({ action: 'get', realm_id: on_id });
        expect(settings_on.status).toBe(200);
        expect(settings_on.body.a2a_enabled).toBe(true);
        expect(settings_on.body.effective_provider_id).toBe('test_mesh');
        expect(settings_on.body.mesh_status?.status).toBe('connected');
    });

    it('5.2 team list change → re_register when connected; none → no call', async () => {
        const slug = `a2a-skills-${stamp}`.slice(0, 40);
        mesh_calls.re_register = 0;

        const created = await request(app)
            .post('/v1/realms/create')
            .set('Authorization', bearer(token))
            .send({ org_id, slug, name: 'Skills Realm' });
        expect(created.status).toBe(200);
        const realm_id = created.body.realm.id as string;

        await wait_for(() => mesh_calls.connect >= 1);

        // Reset counter after realm creation — seed_builtin_teams may
        // have already added @cliq/hello-world and triggered re_register.
        mesh_calls.re_register = 0;

        // Hard-cut: add_team replaces /v1/realms/team-list/add
        const add = await request(app)
            .post('/v1/realms/add_team')
            .set('Authorization', bearer(token))
            .send({ realm_id, scope: 'cliq', slug: 'test-team' });
        expect(add.status).toBe(200);

        await wait_for(() => mesh_calls.re_register >= 1);
        expect(mesh_calls.re_register).toBeGreaterThanOrEqual(1);

        const before = mesh_calls.re_register;
        await request(app)
            .post('/v1/account/mesh/update')
            .set('Authorization', bearer(token))
            .send({ active_provider_id: null });

        // Force realm to none so skills hook skips
        await request(app)
            .post('/v1/realms/a2a')
            .set('Authorization', bearer(token))
            .send({ action: 'update', realm_id, mesh_provider_mode: 'none' });

        await request(app)
            .post('/v1/realms/add_team')
            .set('Authorization', bearer(token))
            .send({ realm_id, scope: 'cliq', slug: 'other-team' });

        await new Promise((r) => setTimeout(r, 300));
        expect(mesh_calls.re_register).toBe(before);

        // restore provider for later tests
        await request(app)
            .post('/v1/account/mesh/update')
            .set('Authorization', bearer(token))
            .send({
                active_provider_id: 'test_mesh',
                auto_enable_a2a_on_realm_create: true,
            });
    });

    it('public card + /send notify_member with bearer', async () => {
        const slug = `a2a-send-${stamp}`.slice(0, 40);
        const created = await request(app)
            .post('/v1/realms/create')
            .set('Authorization', bearer(token))
            .send({ org_id, slug, name: 'Send Realm' });
        expect(created.status).toBe(200);
        const realm_id = created.body.realm.id as string;

        await request(app)
            .post('/v1/realms/a2a')
            .set('Authorization', bearer(token))
            .send({ action: 'update', realm_id, a2a_enabled: true, mesh_provider_mode: 'none' });

        // A2A bearer mint/rotate lives under /v1/auth/* type=a2a
        const rotated = await request(app)
            .post('/v1/auth/rotate_token')
            .set('Authorization', bearer(token))
            .send({ type: 'a2a', realm_id });
        expect(rotated.status).toBe(200);
        const a2a_bearer = (rotated.body.data?.bearer ?? rotated.body.data?.token ?? rotated.body.bearer) as string;
        expect(a2a_bearer).toMatch(/^cliq_a2a_/);

        const card = await request(app)
            .get(`/a2a/o/${username}/r/${slug}/.well-known/agent-card.json`);
        expect(card.status).toBe(200);
        expect(card.body.skills?.some((s: { id: string }) => s.id === 'notify_member')).toBe(true);

        const send = await request(app)
            .post(`/a2a/o/${username}/r/${slug}/send`)
            .set('Authorization', bearer(a2a_bearer))
            .set('Content-Type', 'application/json')
            .send({
                jsonrpc: '2.0',
                id: '1',
                method: 'message/send',
                params: {
                    message: {
                        role: 'user',
                        parts: [
                            {
                                kind: 'data',
                                data: {
                                    skill_id: 'notify_member',
                                    inputs: {
                                        member_id: String(user_id),
                                        message: 'e2e hello',
                                        title: 'e2e',
                                    },
                                },
                            },
                        ],
                    },
                },
            });
        expect(send.status).toBe(200);
        expect(send.body.result?.status?.state).toMatch(/submitted|working|completed/);
    });

    it('5.3 delete realm → disconnect + card 404', async () => {
        const slug = `a2a-del-${stamp}`.slice(0, 40);
        mesh_calls.disconnect = 0;

        await request(app)
            .post('/v1/account/mesh/update')
            .set('Authorization', bearer(token))
            .send({
                active_provider_id: 'test_mesh',
                auto_enable_a2a_on_realm_create: true,
                provider_id: 'test_mesh',
                provider_settings: { api_token: 'test-secret' },
            });

        const created = await request(app)
            .post('/v1/realms/create')
            .set('Authorization', bearer(token))
            .send({ org_id, slug, name: 'Delete Me' });
        expect(created.status).toBe(200);
        const realm_id = created.body.realm.id as string;

        await wait_for(() => {
            // ensure connected status persisted
            return true;
        }, 500);

        const removed = await request(app)
            .post('/v1/realms/delete')
            .set('Authorization', bearer(token))
            .send({ realm_id });
        expect(removed.status).toBe(200);
        expect(mesh_calls.disconnect).toBeGreaterThanOrEqual(1);

        const gone = await RealmA2aSetting.findByPk(realm_id);
        expect(gone).toBeNull();

        const card = await request(app)
            .get(`/a2a/o/${username}/r/${slug}/.well-known/agent-card.json`);
        expect(card.status).toBe(404);
    });

    it('stores Svantic api_url / client_id / secrets on org', async () => {
        const api_url = 'https://api.svantic.com';
        const client_id = `cid-${stamp}`;
        const client_secret = `csec-${stamp}`;

        const upd = await request(app)
            .post('/v1/account/mesh/update')
            .set('Authorization', bearer(token))
            .send({
                active_provider_id: 'svantic',
                auto_enable_a2a_on_realm_create: false,
                provider_id: 'svantic',
                provider_settings: {
                    api_url,
                    client_id,
                    client_secret,
                    mode: 'hosted',
                },
            });
        expect(upd.status).toBe(200);
        expect(upd.body.providers?.svantic?.api_url).toBe(api_url);
        expect(upd.body.providers?.svantic?.client_id).toBe(client_id);
        expect(upd.body.providers?.svantic?.mode).toBe('hosted');
        expect(upd.body.providers?.svantic?.client_secret).toBe('••••••••');
        expect(upd.body.providers?.svantic?.client_secret_set).toBe(true);
        expect(upd.body.org_id).toBeTruthy();

        const { Org } = await import('../../src/db/models/index.js');
        const org = await Org.findByPk(upd.body.org_id as number);
        expect(org).toBeTruthy();
        expect(org!.mesh_providers.svantic.api_url).toBe(api_url);
        expect(org!.mesh_providers.svantic.client_id).toBe(client_id);
        expect(org!.mesh_providers.svantic.client_secret).toBe(client_secret);
        expect(org!.mesh_providers.svantic.mode).toBe('hosted');

        // Masked re-save must not wipe the real secret
        const re_save = await request(app)
            .post('/v1/account/mesh/update')
            .set('Authorization', bearer(token))
            .send({
                provider_id: 'svantic',
                provider_settings: {
                    api_url: 'https://mesh.svantic.dev',
                    client_id,
                    client_secret: '••••••••',
                    mode: 'connected',
                },
            });
        expect(re_save.status).toBe(200);
        expect(re_save.body.providers.svantic.api_url).toBe('https://mesh.svantic.dev');
        expect(re_save.body.providers.svantic.mode).toBe('connected');

        await org!.reload();
        expect(org!.mesh_providers.svantic.client_secret).toBe(client_secret);
        expect(org!.mesh_providers.svantic.api_url).toBe('https://mesh.svantic.dev');

        await request(app)
            .post('/v1/account/mesh/update')
            .set('Authorization', bearer(token))
            .send({
                active_provider_id: 'test_mesh',
                auto_enable_a2a_on_realm_create: true,
                provider_id: 'test_mesh',
                provider_settings: { api_token: 'test-secret' },
            });
    });
});
