import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { no_store } from '../../../src/middleware/no_store.js';

function mock_res() {
    return {
        setHeader: vi.fn().mockReturnThis(),
    } as unknown as Response;
}

describe('no_store middleware', () => {
    it('sets Cache-Control: no-store and calls next', () => {
        const res = mock_res();
        const next = vi.fn() as NextFunction;
        no_store({} as Request, res, next);
        expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('does not swallow next errors — passes through unmodified', () => {
        // Middleware is pure: no branching, no request inspection. This
        // test locks in that it always calls next(void) — never next(err)
        // — so it's safe to sprinkle on any route.
        const res = mock_res();
        const next = vi.fn() as NextFunction;
        no_store({} as Request, res, next);
        expect(next).toHaveBeenCalledWith();
    });
});
