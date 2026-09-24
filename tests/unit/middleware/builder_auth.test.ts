import { describe, it, expect, vi } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response, NextFunction } from 'express';
import { create_builder_auth } from '../../../src/middleware/builder_auth.js';
import { sign_token } from '../../../src/auth/jwt.js';

const SECRET = 'test-secret';
const ALLOWED = ['http://localhost:3000'];

function mock_res() {
    return {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    } as unknown as Response;
}

describe('builder_auth', () => {
    const middleware = create_builder_auth(SECRET, ALLOWED);
    const next = vi.fn() as unknown as NextFunction;

    it('passes when valid JWT is present', () => {
        const token = sign_token({ user_id: hub_legacy_uuid(1), username: 'alice', role: 'user' }, SECRET);
        const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
        const res = mock_res();
        middleware(req, res, next);
        expect(next).toHaveBeenCalled();
    });

    it('passes when Origin header is in allowed_origins list', () => {
        const req = { headers: { origin: 'http://localhost:3000' } } as unknown as Request;
        const res = mock_res();
        middleware(req, res, next);
        expect(next).toHaveBeenCalled();
    });

    it('returns 401 when no JWT and Origin not in allowed list', () => {
        const req = { headers: { origin: 'http://evil.com' } } as unknown as Request;
        const res = mock_res();
        middleware(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 when no Authorization and no Origin headers', () => {
        const req = { headers: {} } as unknown as Request;
        const res = mock_res();
        middleware(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('prefers JWT auth when both JWT and Origin are present', () => {
        const token = sign_token({ user_id: hub_legacy_uuid(1), username: 'alice', role: 'user' }, SECRET);
        const req = {
            headers: {
                authorization: `Bearer ${token}`,
                origin: 'http://evil.com',
            },
        } as unknown as Request;
        const res = mock_res();
        middleware(req, res, next);
        expect(next).toHaveBeenCalled();
    });
});
