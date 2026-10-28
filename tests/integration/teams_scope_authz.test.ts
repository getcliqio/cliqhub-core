/**
 * Who may publish a team (PLAN-team-visibility §3.3) and the token gate.
 *
 *   1. `teams.publish` in the scope's org → 200, whoever wrote the team
 *   2. An org member whose role lacks `teams.publish` → 403
 *   3. Being assigned to the scope (scope_members) doesn't grant publishing → 403
 *   4. A default scope (@cliq) everyone sees doesn't grant publishing → 403
 *   5. Token permissions gate — PAT with teams:['read'] only → publish 403; with write → 200
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import request from 'supertest';
import { TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';
import crypto from 'node:crypto';

import express from 'express';
import { create_auth_middleware } from '../../src/middleware/auth_middleware.js';
import { TeamsService } from '../../src/services/teams_service.js';
import { TeamsController } from '../../src/controllers/teams_controller.js';
import { error_handler } from '../../src/middleware/error_handler.js';
import { make_mock_repos } from '../helpers/test_container.js';

// ── package parser mock ────────────────────────────────────────────────────
vi.mock('../../src/services/package_parser.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/services/package_parser.js')>();
    return {
        ...actual,
        extract_package: vi.fn().mockResolvedValue({
            team_yml: { phases: [], description: 'test', tools: [] },
            roles: [], readme: '',
        }),
        normalize_tags: vi.fn().mockImplementation((t: string[]) => t),
        compute_next_version: vi.fn().mockReturnValue('1.0.1'),
    };
});

// ── org role permissions: which (org, user) pairs hold which permission ────
const granted = vi.hoisted(() => new Set<string>());
vi.mock('../../src/auth/permissions.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/auth/permissions.js')>()),
    require_permission: vi.fn(async (org_id: string, user_id: string, permission: string) => {
        if (!granted.has(`${org_id}|${user_id}|${permission}`)) throw new Error(`Permission '${permission}' is required`);
    }),
}));

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hash'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

// ── App setup ──────────────────────────────────────────────────────────────

const repos = make_mock_repos();

const mock_storage = {
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(Buffer.from('zip-data')),
    delete: vi.fn().mockResolvedValue(undefined),
};

const app = express();
app.use(express.json());
app.use(create_auth_middleware({
    user_repo: repos.user_repo as any,
    token_repo: repos.token_repo as any,
    scope_repo: repos.scope_repo as any,
    org_member_repo: repos.org_member_repo as any,
}));

const teams_service = new TeamsService(
    repos.team_repo as any, repos.version_repo as any,
    repos.tag_repo as any,
    repos.download_log_repo as any, mock_storage as any, '/tmp/test',
    repos.scope_repo as any, repos.audit_repo as any,
);
const teams_ctrl = new TeamsController(teams_service);

app.post('/v1/teams/publish', teams_ctrl.wrap(teams_ctrl.publish));
app.use(error_handler);

// ── Fixtures ───────────────────────────────────────────────────────────────

const ACME_ORG_ID    = hub_legacy_uuid(1);
const ALICE_USER_ID  = hub_legacy_uuid(10);
const ACME_SCOPE_ID  = hub_legacy_uuid(20);
const ALICE_SCOPE_ID = hub_legacy_uuid(21);

const ALICE = {
    id: ALICE_USER_ID, username: 'alice', display_name: 'Alice',
    email: 'alice@test.com', role: 'user' as const,
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

const ALICE_SCOPE = {
    id: ALICE_SCOPE_ID, slug: 'alice',
    visibility: 'public', owner_id: ALICE_USER_ID, org_id: null,
};

const ACME_ORG_SCOPE = {
    id: ACME_SCOPE_ID, slug: 'acme',
    visibility: 'public', owner_id: null, org_id: ACME_ORG_ID,
};

const CLIQ_SCOPE = {
    id: hub_legacy_uuid(22), slug: 'cliq',
    visibility: 'public', owner_id: null, org_id: hub_legacy_uuid(2),
};

const PUBLISH_BODY = {
    name: 'my-agent', bump: 'patch',
    data_base64: Buffer.from('fake-zip').toString('base64'),
};

function pat_prefix(plaintext = TEST_PAT_PLAINTEXT): string {
    return crypto.createHash('sha256').update(plaintext).digest('hex').slice(0, 16);
}

type Pat_row = { id: string; type: string; user_id: string; token_hash: string; permissions: Record<string, unknown>; scopes: string[] };

/**
 * Stub all auth lookups for one request.
 *
 * @param owned_scopes    - scopes returned by find_owned_by_user
 * @param org_memberships - orgs returned by find_orgs_by_user (drives find_by_org_ids call)
 * @param org_scopes      - scopes returned by find_by_org_ids
 * @param member_scopes   - scopes returned by find_member_scopes
 * @param default_scopes  - scopes returned by find_default_scopes
 * @param permissions     - token.permissions (non-empty = frozen grant)
 */
function stub_auth(opts: {
    owned_scopes?: typeof ALICE_SCOPE[];
    org_memberships?: { org_id: string; slug: string }[];
    org_scopes?: typeof ACME_ORG_SCOPE[];
    member_scopes?: typeof ACME_ORG_SCOPE[];
    default_scopes?: typeof ACME_ORG_SCOPE[];
    permissions?: Record<string, unknown>;
}): void {
    const row: Pat_row = {
        id: 'tok-1', type: 'user', user_id: ALICE_USER_ID,
        token_hash: 'hash',
        permissions: opts.permissions ?? {},
        scopes: [],
    };
    repos.token_repo.find_by_prefix.mockResolvedValueOnce(row);
    repos.user_repo.find_profile_by_id.mockResolvedValueOnce(ALICE);
    repos.scope_repo.find_owned_by_user.mockResolvedValueOnce(opts.owned_scopes ?? [ALICE_SCOPE]);
    repos.org_member_repo.find_orgs_by_user.mockResolvedValueOnce(opts.org_memberships ?? []);
    repos.scope_repo.find_member_scopes.mockResolvedValueOnce(opts.member_scopes ?? []);
    repos.scope_repo.find_default_scopes.mockResolvedValueOnce(opts.default_scopes ?? []);
    // find_by_org_ids is only called when org_memberships is non-empty
    if ((opts.org_memberships ?? []).length > 0) {
        repos.scope_repo.find_by_org_ids.mockResolvedValueOnce(opts.org_scopes ?? []);
    }
}

const BEARER = `Bearer ${TEST_PAT_PLAINTEXT}`;

// ── Tests ──────────────────────────────────────────────────────────────────

describe('publish — teams.publish in the scope\'s org (PLAN-team-visibility §3.3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        granted.clear();
        repos.scope_repo.find_by_slug.mockImplementation(async (slug: string) =>
            ({ alice: ALICE_SCOPE, acme: ACME_ORG_SCOPE, cliq: CLIQ_SCOPE } as Record<string, unknown>)[slug] ?? null);
    });

    const publish_new = async (scope: string) => {
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        repos.team_repo.create.mockResolvedValueOnce(hub_legacy_uuid(99));
        repos.version_repo.create.mockResolvedValueOnce(hub_legacy_uuid(100));
        return request(app).post('/v1/teams/publish').set('Authorization', BEARER).send({ ...PUBLISH_BODY, scope });
    };

    it('200: an org role with teams.publish publishes into the org\'s scope', async () => {
        stub_auth({ org_memberships: [{ org_id: ACME_ORG_ID, slug: 'acme' }], org_scopes: [ACME_ORG_SCOPE] });
        granted.add(`${ACME_ORG_ID}|${ALICE_USER_ID}|teams.publish`);
        expect((await publish_new('acme')).status).toBe(200);
    });

    it('200: anyone with teams.publish there updates a team someone else wrote', async () => {
        stub_auth({ org_memberships: [{ org_id: ACME_ORG_ID, slug: 'acme' }], org_scopes: [ACME_ORG_SCOPE] });
        granted.add(`${ACME_ORG_ID}|${ALICE_USER_ID}|teams.publish`);
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce({
            id: hub_legacy_uuid(98), name: 'my-agent', scope: 'acme', author_id: hub_legacy_uuid(77), visibility: 'public',
        });
        repos.version_repo.find_by_team_and_version.mockResolvedValueOnce(null);
        repos.version_repo.create.mockResolvedValueOnce(hub_legacy_uuid(100));
        const res = await request(app).post('/v1/teams/publish').set('Authorization', BEARER).send({ ...PUBLISH_BODY, scope: 'acme' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it('403: an org member whose role lacks teams.publish', async () => {
        stub_auth({ org_memberships: [{ org_id: ACME_ORG_ID, slug: 'acme' }], org_scopes: [ACME_ORG_SCOPE] });
        const res = await request(app).post('/v1/teams/publish').set('Authorization', BEARER).send({ ...PUBLISH_BODY, scope: 'acme' });
        expect(res.status).toBe(403);
        expect(res.body.error.message).toMatch(/Publishing to @acme needs 'teams.publish'/);
    });

    it('403: being assigned to the scope doesn\'t grant publishing', async () => {
        stub_auth({ member_scopes: [ACME_ORG_SCOPE] });
        const res = await request(app).post('/v1/teams/publish').set('Authorization', BEARER).send({ ...PUBLISH_BODY, scope: 'acme' });
        expect(res.status).toBe(403);
    });

    it('403: a default scope everyone sees (@cliq) doesn\'t grant publishing', async () => {
        stub_auth({ default_scopes: [CLIQ_SCOPE] });
        const res = await request(app).post('/v1/teams/publish').set('Authorization', BEARER).send({ ...PUBLISH_BODY, scope: 'cliq' });
        expect(res.status).toBe(403);
    });
});

describe('publish — token permissions (teams grant)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // A legacy personal scope with no org: its owner publishes.
        repos.scope_repo.find_by_slug.mockImplementation(async (slug: string) => (slug === 'alice' ? ALICE_SCOPE : null));
    });

    it('403: PAT with teams:read-only is denied publish', async () => {
        stub_auth({
            owned_scopes: [ALICE_SCOPE],
            permissions: { access: { teams: ['read'] } },
        });

        const res = await request(app)
            .post('/v1/teams/publish')
            .set('Authorization', BEARER)
            .send({ ...PUBLISH_BODY, scope: 'alice' });
        expect(res.status).toBe(403);
        expect(res.body.error.message).toMatch(/teams:write/);
    });

    it('200: PAT with teams:write passes publish', async () => {
        stub_auth({
            owned_scopes: [ALICE_SCOPE],
            permissions: { access: { teams: ['read', 'write'] } },
        });
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        repos.team_repo.create.mockResolvedValueOnce(hub_legacy_uuid(99));
        repos.version_repo.create.mockResolvedValueOnce(hub_legacy_uuid(100));

        const res = await request(app)
            .post('/v1/teams/publish')
            .set('Authorization', BEARER)
            .send({ ...PUBLISH_BODY, scope: 'alice' });
        expect(res.status).toBe(200);
    });

    it('403: PAT with no teams key in access is denied publish', async () => {
        // Explicit empty access.teams means no access
        stub_auth({
            owned_scopes: [ALICE_SCOPE],
            permissions: { access: { teams: [] } },
        });

        const res = await request(app)
            .post('/v1/teams/publish')
            .set('Authorization', BEARER)
            .send({ ...PUBLISH_BODY, scope: 'alice' });
        expect(res.status).toBe(403);
    });

    it('200: PAT with empty permissions ({}) gets full member access by default', async () => {
        // Empty permissions = not frozen → falls back to member default (teams: read+write)
        stub_auth({ owned_scopes: [ALICE_SCOPE], permissions: {} });
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        repos.team_repo.create.mockResolvedValueOnce(hub_legacy_uuid(99));
        repos.version_repo.create.mockResolvedValueOnce(hub_legacy_uuid(100));

        const res = await request(app)
            .post('/v1/teams/publish')
            .set('Authorization', BEARER)
            .send({ ...PUBLISH_BODY, scope: 'alice' });
        expect(res.status).toBe(200);
    });
});
