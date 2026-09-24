import { describe, it, expect, vi } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response, NextFunction } from 'express';
import { deny_daemon_token_outside_allowlist } from '../../../src/middleware/daemon_token_gate.js';

function mock_res() {
    return {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    } as unknown as Response;
}

describe('deny_daemon_token_outside_allowlist', () => {
    it('passes non-daemon credentials', () => {
        const next = vi.fn() as NextFunction;
        const req = { path: '/v1/realms/get', auth: { auth_via: 'jwt' } } as unknown as Request;
        deny_daemon_token_outside_allowlist(req, mock_res(), next);
        expect(next).toHaveBeenCalled();
    });

    it('allows daemon token on register', () => {
        const next = vi.fn() as NextFunction;
        const req = {
            path: '/v1/daemons/register',
            auth: { auth_via: 'daemon_token' },
        } as unknown as Request;
        deny_daemon_token_outside_allowlist(req, mock_res(), next);
        expect(next).toHaveBeenCalled();
    });

    it('allows daemon token on runs create (state push)', () => {
        const next = vi.fn() as NextFunction;
        const req = {
            path: '/v1/runs/create',
            auth: { auth_via: 'daemon_token' },
        } as unknown as Request;
        deny_daemon_token_outside_allowlist(req, mock_res(), next);
        expect(next).toHaveBeenCalled();
    });

    it('blocks daemon token on realms get', () => {
        const next = vi.fn() as NextFunction;
        const res = mock_res();
        const req = {
            path: '/v1/realms/get',
            auth: { auth_via: 'daemon_token' },
        } as unknown as Request;
        deny_daemon_token_outside_allowlist(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it('allows daemon token on dispatch claim', () => {
        const next = vi.fn() as NextFunction;
        const req = {
            path: '/v1/runs/claim',
            auth: { auth_via: 'daemon_token' },
        } as unknown as Request;
        deny_daemon_token_outside_allowlist(req, mock_res(), next);
        expect(next).toHaveBeenCalled();
    });

    it('allows daemon token on reviews create/get_by_id/ack/send_message', () => {
        for (const path of [
            '/v1/reviews/create',
            '/v1/reviews/get_by_id',
            '/v1/reviews/ack',
            '/v1/reviews/send_message',
        ]) {
            const next = vi.fn() as NextFunction;
            const req = {
                path,
                auth: { auth_via: 'daemon_token' },
            } as unknown as Request;
            deny_daemon_token_outside_allowlist(req, mock_res(), next);
            expect(next).toHaveBeenCalled();
        }
    });

    it('blocks daemon token on reviews verdict', () => {
        const next = vi.fn() as NextFunction;
        const res = mock_res();
        const req = {
            path: '/v1/reviews/verdict',
            auth: { auth_via: 'daemon_token' },
        } as unknown as Request;
        deny_daemon_token_outside_allowlist(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(403);
    });
});
