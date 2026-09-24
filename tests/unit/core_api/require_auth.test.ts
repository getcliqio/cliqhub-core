import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../../src/models/index.js', () => ({
    Scope: {
        findAll: vi.fn(async () => [{ id: 'scope-uuid-cliq' }]),
    },
}));

import { require_auth } from '../../../src/middleware/core_auth.js';
import { Scope } from '../../../src/models/index.js';

function mock_res() {
    const res = {
        status_code: 0,
        body: null as unknown,
        status(code: number) {
            this.status_code = code;
            return this;
        },
        json(body: unknown) {
            this.body = body;
            return this;
        },
    };
    return res as unknown as Response & { status_code: number; body: unknown };
}

describe('require_auth (Hub auth only)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('401 when Hub auth did not authenticate', async () => {
        const req = { auth: { user: null, org_slugs: [], org_ids: [], scopes: [] } } as unknown as Request;
        const res = mock_res();
        const next = vi.fn() as NextFunction;

        await require_auth(req, res, next);

        expect(res.status_code).toBe(401);
        expect(next).not.toHaveBeenCalled();
        expect(Scope.findAll).not.toHaveBeenCalled();
    });

    it('sets req.user from Hub auth and continues', async () => {
        const req = {
            auth: {
                user: {
                    id: hub_legacy_uuid(7),
                    email: 'alice@test.com',
                    username: 'alice',
                    display_name: 'alice',
                    role: 'user',
                    suspended_at: null,
                    suspended_reason: '',
                    created_at: '',
                },
                org_slugs: ['acme'],
                org_ids: [hub_legacy_uuid(3)],
                scopes: [{ id: hub_legacy_uuid(1), slug: 'cliq', display_name: null, visibility: 'public', scope_type: 'user', owner_id: hub_legacy_uuid(7), org_id: null }],
            },
            user: undefined,
        } as unknown as Request;
        const res = mock_res();
        const next = vi.fn() as NextFunction;

        await require_auth(req, res, next);

        expect(next).toHaveBeenCalledOnce();
        expect(req.user).toEqual({
            user_id: hub_legacy_uuid(7),
            email: 'alice@test.com',
            role: 'user',
            org_ids: [hub_legacy_uuid(3)],
            scope_ids: ['scope-uuid-cliq'],
            current_org_id: undefined,
        });
        expect(Scope.findAll).toHaveBeenCalledTimes(2);
    });
});
