/**
 * Tests for org context propagation through the Core API auth middleware.
 * Verifies that current_org_id flows from Hub auth → Core API req.user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

vi.mock('../../../src/models/index.js', () => ({
    Scope: {
        findAll: vi.fn().mockResolvedValue([
            { id: 'scope-uuid-1' },
        ]),
    },
}));

import { require_auth } from '../../../src/middleware/core_auth.js';

function make_req(overrides: {
    current_org_id?: string;
    user_id?: string;
    org_ids?: number[];
} = {}) {
    return {
        auth: {
            user: {
                id: overrides.user_id ?? 1,
                username: 'alice',
                display_name: 'Alice',
                email: 'a@a.com',
                role: 'user' as const,
                suspended_at: null,
                suspended_reason: '',
                created_at: '',
            },
            org_slugs: ['alice'],
            org_ids: overrides.org_ids ?? [10],
            scopes: [{ id: hub_legacy_uuid(1), slug: 'alice', display_name: null, visibility: 'public' as const, scope_type: 'user' as const, owner_id: hub_legacy_uuid(1), org_id: null }],
            current_org_id: overrides.current_org_id,
        },
        user: undefined as any,
    } as any;
}

function make_res() {
    const json = vi.fn();
    return { status: vi.fn().mockReturnValue({ json }), json } as any;
}

describe('require_auth — org context propagation', () => {
    beforeEach(() => vi.clearAllMocks());

    it('passes current_org_id through to req.user', async () => {
        const req = make_req({ current_org_id: 10 });
        const res = make_res();
        const next = vi.fn();
        await require_auth(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(req.user.current_org_id).toBe(10);
    });

    it('leaves current_org_id undefined when not set on auth', async () => {
        const req = make_req({});
        const res = make_res();
        const next = vi.fn();
        await require_auth(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(req.user.current_org_id).toBeUndefined();
    });

    it('returns 401 when auth.user is null', async () => {
        const req = { auth: { user: null } } as any;
        const res = make_res();
        const next = vi.fn();
        await require_auth(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });
});
