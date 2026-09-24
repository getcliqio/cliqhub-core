import { describe, it, expect, vi } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response, NextFunction } from 'express';
import { error_handler } from '../../../src/middleware/error_handler.js';
import { ApiError, ParamError } from '../../../src/errors/api_error.js';

function mock_res() {
    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    return res;
}

const mock_req = {} as Request;
const mock_next = vi.fn() as NextFunction;

describe('error_handler', () => {
    it('returns 401 for ApiError with code unauthorized', () => {
        const res = mock_res();
        error_handler(new ApiError('unauthorized', 'Login required'), mock_req, res, mock_next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({
            ok: false,
            error: { code: 'unauthorized', message: 'Login required' },
        });
    });

    it('returns 404 for ApiError with code not_found', () => {
        const res = mock_res();
        error_handler(new ApiError('not_found', 'Not found'), mock_req, res, mock_next);
        expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 422 for ParamError', () => {
        const res = mock_res();
        error_handler(new ParamError('Invalid slug'), mock_req, res, mock_next);
        expect(res.status).toHaveBeenCalledWith(422);
        expect(res.json).toHaveBeenCalledWith({
            ok: false,
            error: { code: 'invalid_params', message: 'Invalid slug' },
        });
    });

    it('returns custom status from ApiError', () => {
        const res = mock_res();
        error_handler(new ApiError('conflict', 'Already exists', 409), mock_req, res, mock_next);
        expect(res.status).toHaveBeenCalledWith(409);
    });

    it('returns status_code for core control-plane ApiError shape', () => {
        const res = mock_res();
        const core_err = Object.assign(new Error('Realm admin role required'), {
            name: 'ApiError',
            status_code: 403,
        });
        error_handler(core_err, mock_req, res, mock_next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({
            ok: false,
            error: { code: 'error', message: 'Realm admin role required' },
        });
    });

    it('returns 500 for unknown Error', () => {
        const res = mock_res();
        error_handler(new Error('unexpected'), mock_req, res, mock_next);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            ok: false,
            error: { code: 'internal_error', message: 'unexpected' },
        });
    });

    it('returns 500 for non-Error thrown value', () => {
        const res = mock_res();
        error_handler('string error' as unknown, mock_req, res, mock_next);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            ok: false,
            error: { code: 'internal_error', message: 'Unknown error' },
        });
    });
});
