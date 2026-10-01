/**
 * Scope-ownership and token-permissions authz for team publish.
 *
 * Covers gaps not exercised by teams_write.test.ts:
 *
 *   1. Org-scope publish — user is an org member whose org owns the scope → 200
 *   2. Org-scope publish — user is NOT a member of the org owning the scope → 403
 *   3. Token permissions gate — PAT with teams:['read'] only → publish 403
 *   4. Token permissions gate — PAT with teams:['read','write'] → publish 200
 *   5. Scope via find_member_scopes (explicit member) → publish 200
 *   6. Default scope included in auth.scopes → publish 200
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
    id: ALICE_SCOPE_ID, slug: 'alice', scope_type: 'user' as const,
    visibility: 'public', owner_id: ALICE_USER_ID, org_id: null,
};

const ACME_ORG_SCOPE = {
    id: ACME_SCOPE_ID, slug: 'acme', scope_type: 'org' as const,
    visibility: 'public', owner_id: null, org_id: ACME_ORG_ID,
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

describe('publish — org scope authz', () => {
    beforeEach(() => vi.clearAllMocks());

    it('200: org member can publish into the org scope', async () => {
        // Alice is a member of acme; acme scope comes from find_by_org_ids
        stub_auth({
            owned_scopes: [ALICE_SCOPE],
            org_memberships: [{ org_id: ACME_ORG_ID, slug: 'acme' }],
            org_scopes: [ACME_ORG_SCOPE],
        });
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        repos.team_repo.create.mockResolvedValueOnce(hub_legacy_uuid(99));
        repos.version_repo.create.mockResolvedValueOnce(hub_legacy_uuid(100));

        const res = await request(app)
            .post('/v1/teams/publish')
            .set('Authorization', BEARER)
            .send({ ...PUBLISH_BODY, scope: 'acme' });
        expect(res.status).toBe(200);
    });

    it('403: non-member cannot publish into a foreign org scope', async () => {
        // Alice has NO org membership → acme not in auth.scopes
        stub_auth({ owned_scopes: [ALICE_SCOPE] });

        const res = await request(app)
            .post('/v1/teams/publish')
            .set('Authorization', BEARER)
            .send({ ...PUBLISH_BODY, scope: 'acme' });
        expect(res.status).toBe(403);
        expect(res.body.error.message).toMatch(/access to scope '@acme'/);
    });

    it('200: scope membership (find_member_scopes) grants publish access', async () => {
        // Alice is an explicit member of acme scope (not via org)
        stub_auth({
            owned_scopes: [ALICE_SCOPE],
            member_scopes: [ACME_ORG_SCOPE],
        });
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        repos.team_repo.create.mockResolvedValueOnce(hub_legacy_uuid(99));
        repos.version_repo.create.mockResolvedValueOnce(hub_legacy_uuid(100));

        const res = await request(app)
            .post('/v1/teams/publish')
            .set('Authorization', BEARER)
            .send({ ...PUBLISH_BODY, scope: 'acme' });
        expect(res.status).toBe(200);
    });

    it('200: default scope (find_default_scopes) grants publish access', async () => {
        // Alice has no org membership, but acme is a platform default scope
        stub_auth({
            owned_scopes: [ALICE_SCOPE],
            default_scopes: [ACME_ORG_SCOPE],
        });
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        repos.team_repo.create.mockResolvedValueOnce(hub_legacy_uuid(99));
        repos.version_repo.create.mockResolvedValueOnce(hub_legacy_uuid(100));

        const res = await request(app)
            .post('/v1/teams/publish')
            .set('Authorization', BEARER)
            .send({ ...PUBLISH_BODY, scope: 'acme' });
        expect(res.status).toBe(200);
    });
});

describe('publish — token permissions (teams grant)', () => {
    beforeEach(() => vi.clearAllMocks());

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
