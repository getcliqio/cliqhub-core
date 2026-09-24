/**
 * Unit tests for `require_token_scope` — the enforcement middleware for
 * PAT capability scopes. Runs without a DB.
 */

import { describe, it, expect, vi } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

import { require_token_scope } from '../../../src/middleware/require_token_scope.js';

interface FakeAuth {
    user?: { id: number };
    auth_via?: 'jwt' | 'pat' | 'daemon_token';
    token_scopes?: string[];
}

function make_req(auth?: FakeAuth) {
    return { auth: auth ?? undefined } as unknown as Parameters<
        ReturnType<typeof require_token_scope>
    >[0];
}

function make_res() {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn().mockReturnThis();
    return { status, json } as unknown as Parameters<
        ReturnType<typeof require_token_scope>
    >[1] & { status: typeof status; json: typeof json };
}

describe('require_token_scope', () => {
    it('401 when no auth user', () => {
        const guard = require_token_scope('dispatch');
        const req = make_req();
        const res = make_res();
        const next = vi.fn();

        guard(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('passes non-PAT auth_via without checking capability scopes', () => {
        const guard = require_token_scope('dispatch');
        const req = make_req({ user: { id: hub_legacy_uuid(1) }, auth_via: 'daemon_token' });
        const res = make_res();
        const next = vi.fn();

        guard(req, res, next);
        expect(next).toHaveBeenCalledOnce();
        expect(res.status).not.toHaveBeenCalled();
    });

    it('passes daemon-token auth without checking scopes', () => {
        const guard = require_token_scope('dispatch');
        const req = make_req({ user: { id: hub_legacy_uuid(1) }, auth_via: 'daemon_token' });
        const res = make_res();
        const next = vi.fn();

        guard(req, res, next);
        expect(next).toHaveBeenCalledOnce();
    });

    it('passes PAT with empty/absent capability scopes', () => {
        const guard = require_token_scope('dispatch');
        const req = make_req({ user: { id: hub_legacy_uuid(1) }, auth_via: 'pat' });
        const res = make_res();
        const next = vi.fn();

        guard(req, res, next);
        expect(next).toHaveBeenCalledOnce();
    });

    it('passes PAT that holds the required scope', () => {
        const guard = require_token_scope('dispatch');
        const req = make_req({
            user: { id: hub_legacy_uuid(1) },
            auth_via: 'pat',
            token_scopes: ['dispatch', 'read:realms'],
        });
        const res = make_res();
        const next = vi.fn();

        guard(req, res, next);
        expect(next).toHaveBeenCalledOnce();
    });

    it('403 when PAT is scoped but missing the required scope', () => {
        const guard = require_token_scope('dispatch');
        const req = make_req({
            user: { id: hub_legacy_uuid(1) },
            auth_via: 'pat',
            token_scopes: ['read:realms'],
        });
        const res = make_res();
        const next = vi.fn();

        guard(req, res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        const body = (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
        expect(JSON.stringify(body)).toMatch(/missing required scope 'dispatch'/);
        expect(next).not.toHaveBeenCalled();
    });
});
