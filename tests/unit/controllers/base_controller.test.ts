import { describe, it, expect, vi } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import { BaseController } from '../../../src/controllers/base_controller.js';

class TestController extends BaseController {
    public test_parse_body<T>(schema: z.ZodSchema<T>, req: Request): T {
        return this.parse_body(schema, req);
    }

    public test_ok<T>(res: Response, data: T, status?: number): void {
        this.ok(res, data, status);
    }

    public test_wrap(handler: (req: Request, res: Response) => Promise<void>) {
        return this.wrap(handler);
    }
}

function mock_res() {
    return {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    } as unknown as Response;
}

describe('BaseController', () => {
    const controller = new TestController();
    const schema = z.object({ name: z.string(), age: z.number().int() });

    it('parse_body returns validated data for valid input', () => {
        const req = { body: { name: 'alice', age: 30 } } as Request;
        const result = controller.test_parse_body(schema, req);
        expect(result).toEqual({ name: 'alice', age: 30 });
    });

    it('parse_body throws ApiError 422 for invalid input', () => {
        const req = { body: { name: 123 } } as Request;
        expect(() => controller.test_parse_body(schema, req)).toThrow();
        try {
            controller.test_parse_body(schema, req);
        } catch (err: any) {
            expect(err.code).toBe('invalid_params');
            expect(err.status).toBe(422);
        }
    });

    it('parse_body includes field path in error message', () => {
        const req = { body: { name: 'alice', age: 'not-a-number' } } as Request;
        try {
            controller.test_parse_body(schema, req);
        } catch (err: any) {
            expect(err.message).toContain('age');
        }
    });

    it('ok sends { ok: true, data } with status 200', () => {
        const res = mock_res();
        controller.test_ok(res, { id: hub_legacy_uuid(1) });
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ ok: true, data: { id: hub_legacy_uuid(1) } });
    });

    it('wrap catches async errors and forwards to next', async () => {
        const handler = async () => { throw new Error('boom'); };
        const wrapped = controller.test_wrap(handler);
        const req = {} as Request;
        const res = mock_res();
        const next = vi.fn() as unknown as NextFunction;

        await wrapped(req, res, next);

        expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
});
