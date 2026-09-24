/**
 * Capability scopes on stored PATs (Forge routes).
 *
 * Minting no longer accepts `scopes` — grants use `permissions` only.
 * Empty `tokens.scopes` = full power (back-compat). Non-empty is still
 * enforced by `require_token_scope` on Forge-facing routes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import request from 'supertest';
import { Sequelize } from 'sequelize';
import crypto from 'node:crypto';

import { create_test_app } from '../helpers/test_container.js';
import { stub_pat_auth, TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';

vi.mock('../../src/auth/password.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/auth/password.js')>();
    return {
        ...actual,
        verify_password: vi.fn().mockResolvedValue(true),
    };
});
import { TokenRepository } from '../../src/repositories/token_repository.js';

const { app, repos } = create_test_app();
const SECRET = 'test-secret';
const real_token_repo = new TokenRepository();

const ALICE = {
    id: hub_legacy_uuid(1),
    username: 'alice',
    display_name: 'alice',
    email: 'alice@test.com',
    role: 'user' as const,
    suspended_at: null,
    suspended_reason: '',
    created_at: '2025-01-01',
};

const DATABASE_URL =
    process.env.DATABASE_URL
    ?? 'postgresql://cliqhub:cliqhub@localhost:5432/cliqhub';

async function postgres_reachable(): Promise<boolean> {
    const probe = new Sequelize(DATABASE_URL, { dialect: 'postgres', logging: false });
    try {
        await probe.authenticate();
        await probe.close();
        return true;
    } catch {
        try { await probe.close(); } catch { /* ignore */ }
        return false;
    }
}

function session_pat_bearer(): string {
    return `Bearer ${TEST_PAT_PLAINTEXT}`;
}

function jwt_bearer(): string {
    // JWT no longer authenticates on Hub — return a non-PAT for negative tests.
    return 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.invalid';
}

function mock_users(): void {
    stub_pat_auth(repos, ALICE, { once: false });
    repos.user_repo.find_by_id.mockImplementation(
        async (id: number) => (id === ALICE.id ? ALICE : null),
    );
    repos.scope_repo.find_owned_by_user.mockResolvedValue([
        {
            id: hub_legacy_uuid(1),
            slug: 'cliq',
            display_name: 'Cliq',
            visibility: 'public',
            scope_type: 'user',
            owner_id: hub_legacy_uuid(1),
            org_id: null,
        },
    ]);
    repos.org_member_repo.find_orgs_by_user.mockResolvedValue([]);
    repos.scope_repo.find_member_scopes.mockResolvedValue([]);
    repos.scope_repo.find_by_org_ids.mockResolvedValue([]);
}

async function mint_pat(scopes?: string[]): Promise<string> {
    const res = await request(app)
        .post('/v1/auth/generate_token')
        .set('Authorization', session_pat_bearer())
        .send({
            type: 'user',
            name: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        });
    expect(res.status).toBe(201);
    const token = res.body.data?.token as string;
    expect(token).toMatch(/^cliq_tok_/);
    if (scopes && scopes.length > 0) {
        const prefix = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
        const { get_sequelize } = await import('../../src/db/sequelize.js');
        await get_sequelize().query(
            `UPDATE tokens SET scopes = :scopes::jsonb WHERE token_prefix = :prefix`,
            { replacements: { scopes: JSON.stringify(scopes), prefix } },
        );
    }
    return token;
}

const ready = await postgres_reachable();

describe.skipIf(!ready)('token capability scopes (slice 1.6)', () => {
    beforeAll(async () => {
        const { init_sequelize, close_sequelize } = await import('../../src/db/sequelize.js');
        const { init_models } = await import('../../src/db/models/index.js');
        const { migrate_hub_schema } = await import('../../src/db/hub_schema_migrations.js');
        const { close_control_plane_store, init_control_plane_store } = await import(
            '../../src/db/control_plane_store.js'
        );
        await close_control_plane_store();
        await close_sequelize();
        const sequelize = init_sequelize(DATABASE_URL);
        init_models(sequelize);
        await sequelize.sync();
        await migrate_hub_schema(sequelize);
        await sequelize.query(`
            INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
            VALUES ('00000000-0000-4000-8000-000000000001', 'alice', 'alice', 'alice@test.com', 'x', 'user', NOW())
            ON CONFLICT (id) DO NOTHING
        `);
        await init_control_plane_store(DATABASE_URL);
    });

    afterAll(async () => {
        const { close_control_plane_store } = await import(
            '../../src/db/control_plane_store.js'
        );
        const { close_sequelize } = await import('../../src/db/sequelize.js');
        await close_control_plane_store();
        await close_sequelize();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mock_users();
        // The shared test container mocks token_repo methods but returns
        // `undefined` from `create` by default — meaning the controller
        // would try to read `record.id` on undefined. This slice needs
        // real DB round-trips (mint → auth-by-prefix → list), so route
        // the relevant methods through the real repository.
        repos.token_repo.create.mockImplementation(
            (input: Parameters<typeof real_token_repo.create>[0]) =>
                real_token_repo.create(input),
        );
        repos.token_repo.find_by_prefix.mockImplementation(
            async (prefix: string) => {
                const session_prefix = crypto.createHash('sha256')
                    .update(TEST_PAT_PLAINTEXT).digest('hex').slice(0, 16);
                if (prefix === session_prefix) {
                    return {
                        id: 'session-pat',
                        type: 'user',
                        user_id: ALICE.id,
                        token_hash: 'hash',
                        permissions: {},
                        scopes: [],
                    };
                }
                return real_token_repo.find_by_prefix(prefix);
            },
        );
        repos.token_repo.update_last_used.mockImplementation(
            (id: string) => real_token_repo.update_last_used(id),
        );
        repos.token_repo.list_by_user_id.mockImplementation(
            (user_id: string, opts) => real_token_repo.list_by_user_id(user_id, opts),
        );
        // `count_by_user_id` is not in the shared mock — add it dynamically
        // (the shared mock ships only what its original callers exercised).
        (repos.token_repo as unknown as Record<string, unknown>).count_by_user_id
            = vi.fn().mockImplementation(
                (user_id: string, opts) => real_token_repo.count_by_user_id(user_id, opts),
            );
    });

    it('mint ignores capability scopes; empty scopes on create', async () => {
        const create = await request(app)
            .post('/v1/auth/generate_token')
            .set('Authorization', session_pat_bearer())
            .send({
                type: 'user',
                name: `jira-${Date.now()}`,
                scopes: ['dispatch', 'read:realms', 'dispatch'],
            });
        expect(create.status).toBe(201);
        expect(create.body.data.token).toMatch(/^cliq_tok_/);
        expect(create.body.data.scopes).toBeUndefined();

        const list = await request(app)
            .post('/v1/auth/get_tokens')
            .set('Authorization', session_pat_bearer())
            .send({ type: 'user' });
        expect(list.status).toBe(200);
        const found = (list.body.data.tokens as Array<{ id: string; scopes: string[] }>)
            .find((t) => t.id === create.body.data.id);
        expect(found?.scopes ?? []).toEqual([]);
    });

    it('legacy PAT (no scopes) passes both scope-guarded routes', async () => {
        const legacy_pat = await mint_pat();

        // dispatch/enqueue with a garbage body still exercises the scope
        // guard before validation — expect NOT 403.
        const enq = await request(app)
            .post('/v1/runs/enqueue')
            .set('Authorization', `Bearer ${legacy_pat}`)
            .send({});
        expect(enq.status).not.toBe(403);

        // Hard-cut: roster lives under /v1/teams/get (no read:realms gate on product route)
        const teams = await request(app)
            .post('/v1/teams/get')
            .set('Authorization', `Bearer ${legacy_pat}`)
            .send({});
        expect(teams.status).not.toBe(403);

        // Dropped path must not exist
        const dropped = await request(app)
            .post('/v1/realms/teams/get')
            .set('Authorization', `Bearer ${legacy_pat}`)
            .send({});
        expect(dropped.status).toBe(404);
    });

    it('scoped PAT — full grant hits dispatch; teams/get stays ungated', async () => {
        const pat = await mint_pat(['dispatch', 'read:realms']);

        const enq = await request(app)
            .post('/v1/runs/enqueue')
            .set('Authorization', `Bearer ${pat}`)
            .send({});
        expect(enq.status).not.toBe(403);

        const teams = await request(app)
            .post('/v1/teams/get')
            .set('Authorization', `Bearer ${pat}`)
            .send({});
        expect(teams.status).not.toBe(403);
    });

    it('scoped PAT missing dispatch → 403 on enqueue, ok on teams', async () => {
        const pat = await mint_pat(['read:realms']);

        const enq = await request(app)
            .post('/v1/runs/enqueue')
            .set('Authorization', `Bearer ${pat}`)
            .send({});
        expect(enq.status).toBe(403);
        expect(String(enq.body.error)).toMatch(/missing required scope 'dispatch'/);

        const teams = await request(app)
            .post('/v1/teams/get')
            .set('Authorization', `Bearer ${pat}`)
            .send({});
        expect(teams.status).not.toBe(403);
    });

    it('scoped PAT with only dispatch → ok on enqueue and teams', async () => {
        const pat = await mint_pat(['dispatch']);

        // read:realms no longer gates a Hub route after realm hard-cut
        const teams = await request(app)
            .post('/v1/teams/get')
            .set('Authorization', `Bearer ${pat}`)
            .send({});
        expect(teams.status).not.toBe(403);

        const enq = await request(app)
            .post('/v1/runs/enqueue')
            .set('Authorization', `Bearer ${pat}`)
            .send({});
        expect(enq.status).not.toBe(403);
    });

    it('JWT Bearer is rejected (no Hub session JWT)', async () => {
        const enq = await request(app)
            .post('/v1/runs/enqueue')
            .set('Authorization', jwt_bearer())
            .send({});
        expect(enq.status).toBe(401);

        // Catalog /v1/teams/get may be readable without auth; realm routes are not
        const realms = await request(app)
            .post('/v1/realms/get')
            .set('Authorization', jwt_bearer())
            .send({});
        expect(realms.status).toBe(401);
    });
});
