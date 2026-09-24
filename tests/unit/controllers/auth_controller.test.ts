import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response, NextFunction } from 'express';
import { AuthController } from '../../../src/controllers/auth_controller.js';

function mock_res() {
    return {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    } as unknown as Response;
}

const mock_auth_service = {
    signup: vi.fn(),
    authenticate_user: vi.fn(),
    issue_session_token: vi.fn(),
    revoke_session_token: vi.fn(),
};

describe('AuthController', () => {
    let controller: AuthController;
    const next = vi.fn() as unknown as NextFunction;

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new AuthController(mock_auth_service as any);
    });

    it('signup rejects missing password', async () => {
        const req = { body: { username: 'alice', email: 'a@b.com' } } as Request;
        const res = mock_res();
        await controller.signup(req, res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('signup rejects missing username', async () => {
        const req = { body: { email: 'a@b.com', password: '12345678' } } as Request;
        const res = mock_res();
        await controller.signup(req, res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('signup rejects missing email', async () => {
        const req = { body: { username: 'alice', password: '12345678' } } as Request;
        const res = mock_res();
        await controller.signup(req, res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('signup delegates to auth_service.signup', async () => {
        const user = {
            id: hub_legacy_uuid(1), username: 'alice', display_name: 'alice', email: 'a@b.com',
            role: 'user', suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
        };
        mock_auth_service.signup.mockResolvedValueOnce({
            user,
            token: 'cliq_tok_x',
            account_id: 10,
            account_slug: 'alice',
            default_realm_id: 'realm-1',
            default_realm_slug: 'alice.default',
            enroll_token: 'cliq_dt_x',
        });
        const req = { body: { username: 'alice', email: 'a@b.com', password: '12345678' } } as Request;
        const res = mock_res();
        await controller.signup(req, res, next);
        expect(mock_auth_service.signup).toHaveBeenCalledWith('alice', 'a@b.com', '12345678');
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            ok: true,
            data: expect.objectContaining({
                account_slug: 'alice',
                default_realm_slug: 'alice.default',
                enroll_token: 'cliq_dt_x',
            }),
        }));
    });

    it('authenticate_user rejects missing password', async () => {
        const req = { body: { username: 'alice' } } as Request;
        const res = mock_res();
        await controller.authenticate_user(req, res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('authenticate_user delegates to auth_service.authenticate_user', async () => {
        const user = {
            id: hub_legacy_uuid(1), username: 'alice', display_name: 'alice', email: 'a@b.com',
            role: 'user', suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
        };
        mock_auth_service.authenticate_user.mockResolvedValueOnce({
            user,
            token: 'cliq_tok_x',
            scopes: ['alice'],
            org_slugs: ['alice'],
            default_realm_id: null,
            default_realm_slug: null,
            default_realm_qualified: null,
            enroll_token: null,
            orgs: [],
        });
        const req = { body: { username: 'alice', password: 'secret' } } as Request;
        const res = mock_res();
        await controller.authenticate_user(req, res, next);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            ok: true,
            data: expect.objectContaining({ token: 'cliq_tok_x' }),
        }));
    });

    it('issue_session_token delegates', async () => {
        mock_auth_service.issue_session_token.mockResolvedValueOnce({
            user_id: hub_legacy_uuid(2), token: 'cliq_tok_target',
        });
        const req = {
            body: { user_id: hub_legacy_uuid(2) },
            auth: { user: { id: hub_legacy_uuid(99), role: 'admin' } },
        } as unknown as Request;
        const res = mock_res();
        await controller.issue_session_token(req, res, next);
        expect(mock_auth_service.issue_session_token).toHaveBeenCalledWith(req.auth, hub_legacy_uuid(2));
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('revoke_session_token delegates', async () => {
        mock_auth_service.revoke_session_token.mockResolvedValueOnce({ ok: true });
        const req = { body: { token: 'cliq_tok_x' } } as Request;
        const res = mock_res();
        await controller.revoke_session_token(req, res, next);
        expect(mock_auth_service.revoke_session_token).toHaveBeenCalledWith('cliq_tok_x');
        expect(res.status).toHaveBeenCalledWith(200);
    });
});
