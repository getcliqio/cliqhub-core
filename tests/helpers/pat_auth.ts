/**
 * PAT auth stubs for create_test_app / mock-repo integration tests.
 *
 * Hub middleware accepts only `cliq_tok_…` and `cliq_dt_…`. Tests that
 * previously used `sign_token` JWTs as Bearer must stub token_repo +
 * password verify so resolve_api_token succeeds.
 */

import crypto from 'node:crypto';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

export const TEST_PAT_PLAINTEXT =
    'cliq_tok_testpat00000000000000000000000000000000';

export function pat_prefix(plaintext: string = TEST_PAT_PLAINTEXT): string {
    return crypto.createHash('sha256').update(plaintext).digest('hex').slice(0, 16);
}

export type Pat_auth_user = {
    id: string | number;
    username: string;
    display_name?: string;
    email?: string;
    role: string;
    suspended_at?: string | null;
    suspended_reason?: string;
    created_at?: string;
};

type Stub_repos = {
    user_repo: {
        find_by_id: { mockResolvedValueOnce: (v: unknown) => unknown; mockResolvedValue: (v: unknown) => unknown };
    };
    token_repo: {
        find_by_prefix: { mockResolvedValueOnce: (v: unknown) => unknown; mockResolvedValue: (v: unknown) => unknown };
        update_last_used?: { mockResolvedValue?: (v: unknown) => unknown };
    };
    scope_repo: {
        find_owned_by_user: { mockResolvedValueOnce: (v: unknown) => unknown; mockResolvedValue: (v: unknown) => unknown };
        find_by_org_ids: { mockResolvedValueOnce: (v: unknown) => unknown; mockResolvedValue: (v: unknown) => unknown };
        find_member_scopes: { mockResolvedValueOnce: (v: unknown) => unknown; mockResolvedValue: (v: unknown) => unknown };
    };
    org_member_repo: {
        find_orgs_by_user: { mockResolvedValueOnce: (v: unknown) => unknown; mockResolvedValue: (v: unknown) => unknown };
    };
};

/**
 * Stub find_by_prefix + user/scope lookups for one request that will
 * present `Authorization: Bearer <plaintext>`.
 *
 * Caller must also mock `verify_password` to return true for that call
 * (tests usually `vi.mock` password.js globally).
 */
export function stub_pat_auth(
    repos: Stub_repos,
    user: Pat_auth_user,
    opts: {
        plaintext?: string;
        permissions?: Record<string, unknown>;
        token_id?: string;
        once?: boolean;
    } = {},
): string {
    const plaintext = opts.plaintext ?? TEST_PAT_PLAINTEXT;
    const once = opts.once !== false;
    const row = {
        id: opts.token_id ?? 'tok-session-1',
        type: 'user',
        user_id: user.id,
        token_hash: 'hash',
        permissions: opts.permissions ?? {},
        scopes: [],
    };

    if (once) {
        repos.token_repo.find_by_prefix.mockResolvedValueOnce(row);
        repos.user_repo.find_by_id.mockResolvedValueOnce({
            display_name: user.username,
            email: `${user.username}@test.com`,
            suspended_at: null,
            suspended_reason: '',
            created_at: '2025-01-01',
            ...user,
        });
        repos.scope_repo.find_owned_by_user.mockResolvedValueOnce([]);
        repos.org_member_repo.find_orgs_by_user.mockResolvedValueOnce([]);
        repos.scope_repo.find_member_scopes.mockResolvedValueOnce([]);
    } else {
        repos.token_repo.find_by_prefix.mockResolvedValue(row);
        repos.user_repo.find_by_id.mockResolvedValue({
            display_name: user.username,
            email: `${user.username}@test.com`,
            suspended_at: null,
            suspended_reason: '',
            created_at: '2025-01-01',
            ...user,
        });
        repos.scope_repo.find_owned_by_user.mockResolvedValue([]);
        repos.org_member_repo.find_orgs_by_user.mockResolvedValue([]);
        repos.scope_repo.find_member_scopes.mockResolvedValue([]);
    }

    return `Bearer ${plaintext}`;
}

/** Convenience: default Alice PAT bearer + once stubs. */
export function stub_alice_pat(
    repos: Stub_repos,
    overrides: Partial<Pat_auth_user> = {},
): string {
    return stub_pat_auth(repos, {
        id: hub_legacy_uuid(1),
        username: 'alice',
        role: 'user',
        ...overrides,
    });
}

/** Ensure verify_password returns true for the next n calls (PAT resolve). */
export function mock_verify_password_ok(
    verify_password: { mockResolvedValueOnce: (v: boolean) => unknown },
    times = 1,
): void {
    for (let i = 0; i < times; i++) {
        verify_password.mockResolvedValueOnce(true);
    }
}
