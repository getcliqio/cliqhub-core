/**
 * Tests for resolve_current_org_id — the function that derives
 * the active org context from request headers and auth state.
 */
import { describe, it, expect } from 'vitest';
import { resolve_current_org_id } from '../../../src/middleware/auth_middleware.js';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

function make_auth(overrides: Partial<{
    user: { username: string } | null;
    org_ids: string[];
    org_slugs: string[];
}> = {}) {
    return {
        user: overrides.user ?? { username: 'alice' },
        org_ids: overrides.org_ids ?? [hub_legacy_uuid(10), hub_legacy_uuid(20)],
        org_slugs: overrides.org_slugs ?? ['alice', 'acme'],
    };
}

function make_req(headers: Record<string, string | undefined> = {}) {
    return { headers };
}

describe('resolve_current_org_id', () => {
    it('returns undefined for unauthenticated users', () => {
        const result = resolve_current_org_id(
            make_req(),
            make_auth({ user: null, org_ids: [], org_slugs: [] }),
        );
        expect(result).toBeUndefined();
    });

    it('defaults to personal org (slug === username)', () => {
        const result = resolve_current_org_id(
            make_req(),
            make_auth(),
        );
        expect(result).toBe(hub_legacy_uuid(10));
    });

    it('falls back to first org when personal org is missing', () => {
        const result = resolve_current_org_id(
            make_req(),
            make_auth({ org_slugs: ['acme', 'beta'], org_ids: [hub_legacy_uuid(20), hub_legacy_uuid(30)] }),
        );
        expect(result).toBe(hub_legacy_uuid(20));
    });

    it('honors X-Org-Id header when the user is a member', () => {
        const result = resolve_current_org_id(
            make_req({ 'x-org-id': hub_legacy_uuid(20) }),
            make_auth(),
        );
        expect(result).toBe(hub_legacy_uuid(20));
    });

    it('ignores X-Org-Id header when user is not a member of that org', () => {
        const result = resolve_current_org_id(
            make_req({ 'x-org-id': hub_legacy_uuid(999) }),
            make_auth(),
        );
        expect(result).toBe(hub_legacy_uuid(10));
    });

    it('ignores garbage X-Org-Id header', () => {
        const result = resolve_current_org_id(
            make_req({ 'x-org-id': 'garbage' }),
            make_auth(),
        );
        expect(result).toBe(hub_legacy_uuid(10));
    });

    it('handles array-valued header (takes first)', () => {
        const result = resolve_current_org_id(
            { headers: { 'x-org-id': [hub_legacy_uuid(20), hub_legacy_uuid(30)] } },
            make_auth(),
        );
        expect(result).toBe(hub_legacy_uuid(20));
    });

    it('returns undefined when user has no org memberships', () => {
        const result = resolve_current_org_id(
            make_req(),
            make_auth({ org_ids: [], org_slugs: [] }),
        );
        expect(result).toBeUndefined();
    });
});
