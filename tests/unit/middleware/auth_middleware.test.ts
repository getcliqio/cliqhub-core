import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response } from 'express';
import { create_auth_middleware } from '../../../src/middleware/auth_middleware.js';
import { sign_token } from '../../../src/auth/jwt.js';

vi.mock('../../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hash'),
    verify_password: vi.fn().mockResolvedValue(false),
}));

const mock_resolve_token = vi.hoisted(() => vi.fn());
vi.mock('../../../src/services/realm.service.js', () => ({
    RealmService: { resolve_token: mock_resolve_token },
}));

import { verify_password } from '../../../src/auth/password.js';

const SECRET = 'test-secret';

const ALICE = {
    id: hub_legacy_uuid(1), username: 'alice', display_name: 'Alice',
    email: 'alice@test.com', role: 'user',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

function make_deps() {
    return {
        user_repo: {
            find_profile_by_id: vi.fn().mockResolvedValue(null),
            find_by_username: vi.fn(), find_by_email: vi.fn(),
            find_by_username_or_email: vi.fn(),
            create: vi.fn(), find_by_id_with_transaction: vi.fn(),
        },
        token_repo: {
            find_by_prefix: vi.fn().mockResolvedValue(null),
            update_last_used: vi.fn().mockResolvedValue(undefined),
            create: vi.fn(), delete_by_id_and_user: vi.fn(), list_by_user_id: vi.fn(),
        },
        scope_repo: {
            find_owned_by_user: vi.fn().mockResolvedValue([]),
            find_by_org_ids: vi.fn().mockResolvedValue([]),
            find_member_scopes: vi.fn().mockResolvedValue([]),
            find_default_scopes: vi.fn().mockResolvedValue([]),
            create: vi.fn(),
        },
        org_member_repo: {
            find_orgs_by_user: vi.fn().mockResolvedValue([]),
        },
    };
}

function make_req(auth_header?: string): Request {
    return { headers: { authorization: auth_header } } as unknown as Request;
}

function make_res(): Response {
    return {} as Response;
}

describe('create_auth_middleware', () => {
    let deps: ReturnType<typeof make_deps>;

    beforeEach(() => {
        vi.clearAllMocks();
        deps = make_deps();
    });

    it('sets UNAUTHED when no Authorization header', async () => {
        const mw = create_auth_middleware(deps as any);
        const req = make_req();
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.user).toBeNull();
        expect(next).toHaveBeenCalled();
    });

    it('sets UNAUTHED for non-Bearer header', async () => {
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Basic abc');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.user).toBeNull();
    });

    it('sets UNAUTHED for JWT Bearer (no Hub session JWT)', async () => {
        const mw = create_auth_middleware(deps as any);
        const token = sign_token({ user_id: hub_legacy_uuid(1), username: 'alice', role: 'user' }, SECRET);
        const req = make_req(`Bearer ${token}`);
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.user).toBeNull();
        expect(deps.user_repo.find_profile_by_id).not.toHaveBeenCalled();
    });

    it('sets UNAUTHED for cliq_dk_ Bearer', async () => {
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_dk_abcdef1234567890abcdef1234567890abcdef1234567890');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.user).toBeNull();
        expect(deps.token_repo.find_by_prefix).not.toHaveBeenCalled();
    });

    it('resolves cliq_tok_ API token via prefix lookup', async () => {
        vi.mocked(verify_password).mockResolvedValueOnce(true);
        deps.token_repo.find_by_prefix.mockResolvedValueOnce({
            id: hub_legacy_uuid(10), type: 'user', user_id: hub_legacy_uuid(1), token_hash: 'hash',
            permissions: { domains: { orgs: '*' }, access: {} }, name: 'CI',
        });
        deps.user_repo.find_profile_by_id.mockResolvedValueOnce(ALICE);
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.user?.username).toBe('alice');
        expect(req.auth.auth_via).toBe('pat');
        expect(req.auth.token_permissions).toEqual({ domains: { orgs: '*' }, access: {} });
    });

    it('does not freeze grants on session-scoped PATs (name session:…)', async () => {
        vi.mocked(verify_password).mockResolvedValueOnce(true);
        deps.token_repo.find_by_prefix.mockResolvedValueOnce({
            id: hub_legacy_uuid(11), type: 'user', user_id: hub_legacy_uuid(1), token_hash: 'hash',
            permissions: { domains: { orgs: '*' }, access: { users: ['admin'] } },
            name: 'session:2026-01-01T00:00:00.000Z',
        });
        deps.user_repo.find_profile_by_id.mockResolvedValueOnce(ALICE);
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_sessionpat00000000000000000000000000000000');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.user?.username).toBe('alice');
        expect(req.auth.token_permissions).toBeUndefined();
    });

    it('loads scopes into auth context for PAT', async () => {
        vi.mocked(verify_password).mockResolvedValueOnce(true);
        deps.token_repo.find_by_prefix.mockResolvedValueOnce({
            id: hub_legacy_uuid(10), type: 'user', user_id: hub_legacy_uuid(1), token_hash: 'hash', permissions: {},
        });
        deps.user_repo.find_profile_by_id.mockResolvedValueOnce(ALICE);
        deps.scope_repo.find_owned_by_user.mockResolvedValueOnce([
            { id: hub_legacy_uuid(1), slug: 'alice', scope_type: 'user' },
        ]);
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.scopes).toHaveLength(1);
    });

    it('sets UNAUTHED for invalid API token hash', async () => {
        vi.mocked(verify_password).mockResolvedValueOnce(false);
        deps.token_repo.find_by_prefix.mockResolvedValueOnce({
            id: hub_legacy_uuid(10), type: 'user', user_id: hub_legacy_uuid(1), token_hash: 'hash', permissions: {},
        });
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.user).toBeNull();
    });

    it('sets UNAUTHED for missing API token prefix', async () => {
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_unknowntoken');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.user).toBeNull();
    });

    it('sets UNAUTHED for suspended user on PAT', async () => {
        vi.mocked(verify_password).mockResolvedValueOnce(true);
        deps.token_repo.find_by_prefix.mockResolvedValueOnce({
            id: hub_legacy_uuid(10), type: 'user', user_id: hub_legacy_uuid(1), token_hash: 'hash', permissions: {},
        });
        deps.user_repo.find_profile_by_id.mockResolvedValueOnce({ ...ALICE, suspended_at: '2025-06-01' });
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.user).toBeNull();
    });

    it('loads org_slugs into auth context for PAT', async () => {
        vi.mocked(verify_password).mockResolvedValueOnce(true);
        deps.token_repo.find_by_prefix.mockResolvedValueOnce({
            id: hub_legacy_uuid(10), type: 'user', user_id: hub_legacy_uuid(1), token_hash: 'hash', permissions: {},
        });
        deps.user_repo.find_profile_by_id.mockResolvedValueOnce(ALICE);
        deps.org_member_repo.find_orgs_by_user.mockResolvedValueOnce([
            { slug: 'acme', role: 'admin', org_id: hub_legacy_uuid(1) },
        ]);
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.org_slugs).toEqual(['acme']);
    });

    it('sets UNAUTHED for soft-revoked PAT (find_by_prefix filters revoked_at)', async () => {
        // Token repo WHERE already excludes revoked_at IS NOT NULL rows.
        // Revoked token looks identical to unknown prefix from the middleware's view.
        deps.token_repo.find_by_prefix.mockResolvedValueOnce(null);
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.user).toBeNull();
        expect(req.auth.auth_via).toBeUndefined();
    });

    it('calls update_last_used on successful PAT auth', async () => {
        vi.mocked(verify_password).mockResolvedValueOnce(true);
        const TOKEN_ID = hub_legacy_uuid(10);
        deps.token_repo.find_by_prefix.mockResolvedValueOnce({
            id: TOKEN_ID, type: 'user', user_id: hub_legacy_uuid(1), token_hash: 'hash', permissions: {},
        });
        deps.user_repo.find_profile_by_id.mockResolvedValueOnce(ALICE);
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        await mw(req, make_res(), vi.fn());
        expect(deps.token_repo.update_last_used).toHaveBeenCalledWith(TOKEN_ID);
    });

    it('populates org_ids from all memberships on successful PAT auth', async () => {
        vi.mocked(verify_password).mockResolvedValueOnce(true);
        deps.token_repo.find_by_prefix.mockResolvedValueOnce({
            id: hub_legacy_uuid(10), type: 'user', user_id: hub_legacy_uuid(1), token_hash: 'hash', permissions: {},
        });
        deps.user_repo.find_profile_by_id.mockResolvedValueOnce(ALICE);
        const org1 = hub_legacy_uuid(20);
        const org2 = hub_legacy_uuid(21);
        deps.org_member_repo.find_orgs_by_user.mockResolvedValueOnce([
            { slug: 'acme', role: 'admin', org_id: org1 },
            { slug: 'beta', role: 'member', org_id: org2 },
        ]);
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        await mw(req, make_res(), vi.fn());
        expect(req.auth.org_ids).toEqual([org1, org2]);
        expect(req.auth.org_slugs).toEqual(['acme', 'beta']);
    });

    it('resolves cliq_dt_ daemon token: auth_via, realm_id, user, token_permissions', async () => {
        const creator_id = hub_legacy_uuid(5);
        const realm_id = hub_legacy_uuid(99);
        mock_resolve_token.mockResolvedValueOnce({
            token_id: hub_legacy_uuid(50),
            realm_id,
            created_by: creator_id,
            permissions: { daemons: { access: ['write'] } },
        });
        deps.user_repo.find_profile_by_id.mockResolvedValueOnce({ ...ALICE, id: creator_id });
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_dt_validtoken00000000000000000000000');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.auth_via).toBe('daemon_token');
        expect(req.auth.realm_id).toBe(realm_id);
        expect(req.auth.user?.id).toBe(creator_id);
        expect(req.auth.token_permissions).toEqual({ daemons: { access: ['write'] } });
        expect(next).toHaveBeenCalled();
    });

    it('sets UNAUTHED for cliq_dt_ when resolve_token throws', async () => {
        mock_resolve_token.mockRejectedValueOnce(new Error('invalid token'));
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_dt_invalidtoken000000000000000000000');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.user).toBeNull();
        expect(req.auth.auth_via).toBeUndefined();
    });

    it('sets UNAUTHED for cliq_dt_ when creator user is suspended', async () => {
        mock_resolve_token.mockResolvedValueOnce({
            token_id: hub_legacy_uuid(50),
            realm_id: hub_legacy_uuid(99),
            created_by: hub_legacy_uuid(5),
            permissions: {},
        });
        deps.user_repo.find_profile_by_id.mockResolvedValueOnce({ ...ALICE, suspended_at: '2025-09-01' });
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_dt_validtoken00000000000000000000000');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.user).toBeNull();
    });
});

// ── build_auth_context — scope-merging behaviour ────────────────────────────

describe('build_auth_context — scope population', () => {
    let deps: ReturnType<typeof make_deps>;

    function stub_token(permissions: Record<string, unknown> = {}): void {
        vi.mocked(verify_password).mockResolvedValueOnce(true);
        deps.token_repo.find_by_prefix.mockResolvedValueOnce({
            id: hub_legacy_uuid(50), type: 'user',
            user_id: hub_legacy_uuid(1), token_hash: 'hash', permissions,
        });
        deps.user_repo.find_profile_by_id.mockResolvedValueOnce(ALICE);
    }

    beforeEach(() => {
        vi.clearAllMocks();
        deps = make_deps();
    });

    it('org scopes (find_by_org_ids) appear in auth.scopes when user is an org member', async () => {
        stub_token();
        deps.org_member_repo.find_orgs_by_user.mockResolvedValueOnce([
            { org_id: hub_legacy_uuid(2), slug: 'acme' },
        ]);
        deps.scope_repo.find_by_org_ids.mockResolvedValueOnce([
            { id: hub_legacy_uuid(30), slug: 'acme', scope_type: 'org' },
        ]);
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        await mw(req, make_res(), vi.fn());

        const slug_list = (req.auth.scopes ?? []).map((s: { slug: string }) => s.slug);
        expect(slug_list).toContain('acme');
    });

    it('member scopes (find_member_scopes) appear in auth.scopes', async () => {
        stub_token();
        deps.scope_repo.find_member_scopes.mockResolvedValueOnce([
            { id: hub_legacy_uuid(31), slug: 'partner-org', scope_type: 'org' },
        ]);
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        await mw(req, make_res(), vi.fn());

        const slug_list = (req.auth.scopes ?? []).map((s: { slug: string }) => s.slug);
        expect(slug_list).toContain('partner-org');
    });

    it('default scopes (find_default_scopes) appear in auth.scopes', async () => {
        stub_token();
        deps.scope_repo.find_default_scopes.mockResolvedValueOnce([
            { id: hub_legacy_uuid(32), slug: 'cliq', scope_type: 'org' },
        ]);
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        await mw(req, make_res(), vi.fn());

        const slug_list = (req.auth.scopes ?? []).map((s: { slug: string }) => s.slug);
        expect(slug_list).toContain('cliq');
    });

    it('duplicate scope id across sources appears exactly once in auth.scopes', async () => {
        const shared_scope = { id: hub_legacy_uuid(40), slug: 'shared', scope_type: 'org' };
        stub_token();
        // Same scope returned from both find_owned_by_user and find_member_scopes
        deps.scope_repo.find_owned_by_user.mockResolvedValueOnce([shared_scope]);
        deps.scope_repo.find_member_scopes.mockResolvedValueOnce([shared_scope]);
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        await mw(req, make_res(), vi.fn());

        const matches = (req.auth.scopes ?? []).filter((s: { id: string }) => s.id === hub_legacy_uuid(40));
        expect(matches).toHaveLength(1);
    });

    it('all four scope sources are merged into auth.scopes', async () => {
        stub_token();
        deps.scope_repo.find_owned_by_user.mockResolvedValueOnce([
            { id: hub_legacy_uuid(51), slug: 'alice', scope_type: 'user' },
        ]);
        deps.org_member_repo.find_orgs_by_user.mockResolvedValueOnce([
            { org_id: hub_legacy_uuid(2), slug: 'acme' },
        ]);
        deps.scope_repo.find_by_org_ids.mockResolvedValueOnce([
            { id: hub_legacy_uuid(52), slug: 'acme', scope_type: 'org' },
        ]);
        deps.scope_repo.find_member_scopes.mockResolvedValueOnce([
            { id: hub_legacy_uuid(53), slug: 'partner', scope_type: 'org' },
        ]);
        deps.scope_repo.find_default_scopes.mockResolvedValueOnce([
            { id: hub_legacy_uuid(54), slug: 'cliq', scope_type: 'org' },
        ]);
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        await mw(req, make_res(), vi.fn());

        const slugs = (req.auth.scopes ?? []).map((s: { slug: string }) => s.slug);
        expect(slugs).toContain('alice');
        expect(slugs).toContain('acme');
        expect(slugs).toContain('partner');
        expect(slugs).toContain('cliq');
        expect(req.auth.scopes).toHaveLength(4);
    });
});
