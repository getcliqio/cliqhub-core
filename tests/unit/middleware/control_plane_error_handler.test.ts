/** `/v1` error replies: every one carries a `code` (its own, else the one for its status). */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import { core_api_error_handler } from '../../../src/middleware/control_plane_error_handler.js';
import { ApiError as LibApiError } from '../../../src/lib/api_error.js';
import { ApiError } from '../../../src/errors/api_error.js';

function reply(err: unknown): { status: number; body: Record<string, unknown> } {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
    core_api_error_handler(err, {} as Request, res, vi.fn() as NextFunction);
    return {
        status: (res.status as ReturnType<typeof vi.fn>).mock.calls[0][0],
        body: (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0],
    };
}

describe('core_api_error_handler', () => {
    it('a body that fails its zod schema is 422 invalid_params with the failing fields', () => {
        let err: unknown;
        try { z.object({ run_id: z.string({ required_error: 'run_id is required' }) }).parse({}); } catch (e) { err = e; }
        expect(reply(err)).toEqual({
            status: 422,
            body: {
                ok: false, error: 'run_id is required', code: 'invalid_params',
                details: { issues: [{ field: 'run_id', message: 'run_id is required' }] },
            },
        });
    });

    it('a codeless control-plane ApiError gets the code for its status', () => {
        expect(reply(LibApiError.not_found('Run not found'))).toEqual({ status: 404, body: { ok: false, error: 'Run not found', code: 'not_found' } });
        expect(reply(LibApiError.conflict('Busy'))).toEqual({ status: 409, body: { ok: false, error: 'Busy', code: 'conflict' } });
        expect(reply(LibApiError.service_unavailable('Down')).body.code).toBe('service_unavailable');
        expect(reply(new LibApiError(418, 'Teapot')).body.code).toBe('error');
    });

    it('an ApiError keeps its own code', () => {
        expect(reply(LibApiError.conflict('Stranded', 'run/stranded')).body.code).toBe('run/stranded');
        expect(reply(new LibApiError(422, 'Message blocked by content filter', 'content_blocked')).body.code).toBe('content_blocked');
        expect(reply(new ApiError('locked', 'Locked'))).toMatchObject({ status: 409, body: { code: 'locked' } });
    });

    it('artifact errors have real statuses', () => {
        expect(reply(new ApiError('invalid_request', 'Missing multipart boundary'))).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
        expect(reply(new ApiError('storage_not_configured', 'R2 storage not configured'))).toMatchObject({ status: 503, body: { code: 'storage_not_configured' } });
    });

    it('database and unexpected errors carry codes', () => {
        expect(reply(Object.assign(new Error('dup'), { name: 'SequelizeUniqueConstraintError' }))).toMatchObject({ status: 400, body: { code: 'bad_request' } });
        expect(reply(Object.assign(new Error('fk'), { name: 'SequelizeForeignKeyConstraintError' }))).toMatchObject({ status: 409, body: { code: 'conflict' } });
        expect(reply(new Error('boom'))).toMatchObject({ status: 500, body: { code: 'internal_error' } });
    });
});
