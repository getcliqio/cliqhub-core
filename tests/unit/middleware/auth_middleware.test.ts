import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response } from 'express';
import { create_auth_middleware } from '../../../src/middleware/auth_middleware.js';
import { sign_token } from '../../../src/auth/jwt.js';

vi.mock('../../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hash'),
    verify_password: vi.fn().mockResolvedValue(false),
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
            find_by_id: vi.fn().mockResolvedValue(null),
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
            find_by_slug: vi.fn(), find_by_slug_with_transaction: vi.fn(),
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
        expect(deps.user_repo.find_by_id).not.toHaveBeenCalled();
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
        deps.user_repo.find_by_id.mockResolvedValueOnce(ALICE);
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
        deps.user_repo.find_by_id.mockResolvedValueOnce(ALICE);
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
        deps.user_repo.find_by_id.mockResolvedValueOnce(ALICE);
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
        deps.user_repo.find_by_id.mockResolvedValueOnce({ ...ALICE, suspended_at: '2025-06-01' });
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
        deps.user_repo.find_by_id.mockResolvedValueOnce(ALICE);
        deps.org_member_repo.find_orgs_by_user.mockResolvedValueOnce([
            { slug: 'acme', role: 'admin', org_id: hub_legacy_uuid(1) },
        ]);
        const mw = create_auth_middleware(deps as any);
        const req = make_req('Bearer cliq_tok_abcdef1234567890abcdef1234567890abcdef1234567890');
        const next = vi.fn();
        await mw(req, make_res(), next);
        expect(req.auth.org_slugs).toEqual(['acme']);
    });
});
