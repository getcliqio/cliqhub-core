/**
 * Hub Bearer helpers for migrated_platform tests.
 * Hub accepts only `cliq_tok_…` / `cliq_dt_…` — no session JWT.
 */

import { stub_pat_auth, TEST_PAT_PLAINTEXT, type Pat_auth_user } from '../../helpers/pat_auth.js';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

export const test_hub_pat = TEST_PAT_PLAINTEXT;
export const test_org_id = hub_legacy_uuid(1);

export type Hub_bearer_overrides = {
    user_id?: string;
    username?: string;
    role?: 'user' | 'admin';
    org_ids?: Array<string | number>;
    scopes?: string[];
};

/** Plain Bearer string (does not stub repos — use stub_hub_pat_auth for that). */
export function make_hub_bearer(overrides: Hub_bearer_overrides = {}): string {
    void overrides; // identity carried by stubbed token_repo row / user_repo
    return `Bearer ${test_hub_pat}`;
}

/** @deprecated use make_hub_bearer — no JWT payload anymore */
export function make_hub_jwt(overrides: Hub_bearer_overrides = {}): string {
    return test_hub_pat;
}

/**
 * Stub token_repo + user lookups so middleware accepts make_hub_bearer().
 * Prefer once:false when the suite reuses the same identity across requests.
 */
export function stub_hub_pat_auth(
    repos: Parameters<typeof stub_pat_auth>[0],
    overrides: Hub_bearer_overrides = {},
    opts: { once?: boolean } = {},
): string {
    const user: Pat_auth_user = {
        id: overrides.user_id ?? hub_legacy_uuid(1),
        username: overrides.username ?? 'migrated-platform-user',
        role: overrides.role ?? 'user',
    };
    return stub_pat_auth(repos, user, {
        plaintext: test_hub_pat,
        once: opts.once ?? false,
    });
}
