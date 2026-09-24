/**
 * Tests for the inbound dedup middleware (with_dedup).
 *
 * Uses mock req/res objects — no database needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// ── Mocks ────────────────────────────────────────────────────────────

// In-memory dedup store for the mock.
const _dedup_store = new Map<string, { endpoint: string; status_code: number; response: string; created_at: number }>();

vi.mock('../../../src/db/control_plane_store.js', () => ({
    get_control_plane_store: vi.fn(() => ({
        sequelize: {
            query: vi.fn(async (sql: string, opts: { replacements?: unknown[] }) => {
                const trimmed = sql.trim().toUpperCase();
                const params = opts.replacements ?? [];

                // SELECT lookup.
                if (trimmed.startsWith('SELECT')) {
                    const tx_id = params[0] as string;
                    const row = _dedup_store.get(tx_id);
                    return [row ? [row] : []];
                }

                // INSERT record.
                if (trimmed.startsWith('INSERT')) {
                    const [tx_id, endpoint, status_code, response, created_at] = params as [string, string, number, string, number];
                    _dedup_store.set(tx_id, { endpoint, status_code, response, created_at });
                    return [[], 1];
                }

                // DELETE gc.
                if (trimmed.startsWith('DELETE')) {
                    const cutoff = params[0] as number;
                    for (const [key, val] of _dedup_store.entries()) {
                        if (val.created_at < cutoff) _dedup_store.delete(key);
                    }
                    return [[], 0];
                }

                return [[], 0];
            }),
        },
    })),
}));

vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }),
}));

import { with_dedup, start_dedup_gc, stop_dedup_gc } from '../../../src/middleware/inbound_dedup.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a mock Response that captures status and json. */
function mock_res() {
    const res = {
        _status: 200,
        _body: null as unknown,
        statusCode: 200,
        status(code: number) {
            this._status = code;
            this.statusCode = code;
            return this;
        },
        json(body: unknown) {
            this._body = body;
            return this;
        },
    };
    return res as unknown as Response & { _status: number; _body: unknown };
}

/** Create a mock Request with the given body and URL. */
function mock_req(body: Record<string, unknown>, url = '/v1/runs/create') {
    return { body, originalUrl: url, url } as unknown as Request;
}

// ── Setup ────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    _dedup_store.clear();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('with_dedup', () => {
    it('rejects requests without tx_id with 400', async () => {
        const handler = vi.fn();
        const wrapped = with_dedup(handler);
        const req = mock_req({ run_id: 'r-1' });
        const res = mock_res();
        const next = vi.fn();

        wrapped(req, res, next);
        // Allow the async _handle_dedup to complete.
        await vi.waitFor(() => expect(res._body).not.toBeNull());

        expect(res._status).toBe(400);
        expect((res._body as Record<string, unknown>).error).toBe('tx_id is required');
        expect(handler).not.toHaveBeenCalled();
    });

    it('executes handler on first call and caches response', async () => {
        const handler = vi.fn((_req: Request, res: Response) => {
            res.status(200).json({ ok: true, run_id: 'r-1' });
        });
        const wrapped = with_dedup(handler);
        const req = mock_req({ tx_id: 'tx-abc', run_id: 'r-1' });
        const res = mock_res();
        const next = vi.fn();

        wrapped(req, res, next);
        await vi.waitFor(() => expect(res._body).not.toBeNull());

        expect(handler).toHaveBeenCalledTimes(1);
        expect(res._status).toBe(200);
        expect((res._body as Record<string, unknown>).ok).toBe(true);

        // Dedup store has the entry.
        expect(_dedup_store.has('tx-abc')).toBe(true);
    });

    it('returns cached response on second call without re-executing handler', async () => {
        const handler = vi.fn((_req: Request, res: Response) => {
            res.status(200).json({ ok: true, run_id: 'r-1' });
        });
        const wrapped = with_dedup(handler);

        // First call — populates cache.
        const req1 = mock_req({ tx_id: 'tx-dup', run_id: 'r-1' });
        const res1 = mock_res();
        wrapped(req1, res1, vi.fn());
        await vi.waitFor(() => expect(res1._body).not.toBeNull());
        expect(handler).toHaveBeenCalledTimes(1);

        // Second call — should return cached.
        const req2 = mock_req({ tx_id: 'tx-dup', run_id: 'r-1' });
        const res2 = mock_res();
        wrapped(req2, res2, vi.fn());
        await vi.waitFor(() => expect(res2._body).not.toBeNull());

        expect(handler).toHaveBeenCalledTimes(1); // NOT called again
        expect(res2._status).toBe(200);
        expect((res2._body as Record<string, unknown>).ok).toBe(true);
    });

    it('caches error responses too', async () => {
        const handler = vi.fn((_req: Request, res: Response) => {
            res.status(404).json({ ok: false, error: 'Run not found' });
        });
        const wrapped = with_dedup(handler);
        const req = mock_req({ tx_id: 'tx-err' });
        const res = mock_res();

        wrapped(req, res, vi.fn());
        await vi.waitFor(() => expect(res._body).not.toBeNull());

        expect(res._status).toBe(404);
        const cached = _dedup_store.get('tx-err');
        expect(cached).toBeDefined();
        expect(cached!.status_code).toBe(404);
    });

    it('does not cache when handler calls next(err)', async () => {
        const test_error = new Error('boom');
        const handler = vi.fn((_req: Request, _res: Response, next: NextFunction) => {
            next(test_error);
        });
        const wrapped = with_dedup(handler);
        const req = mock_req({ tx_id: 'tx-fail' });
        const res = mock_res();
        const next = vi.fn();

        wrapped(req, res, next);
        await vi.waitFor(() => expect(next).toHaveBeenCalled());

        expect(next).toHaveBeenCalledWith(test_error);
        expect(_dedup_store.has('tx-fail')).toBe(false);
    });

    it('handles async handlers', async () => {
        const handler = vi.fn(async (_req: Request, res: Response) => {
            await new Promise((r) => setTimeout(r, 10));
            res.status(200).json({ ok: true, async: true });
        });
        const wrapped = with_dedup(handler);
        const req = mock_req({ tx_id: 'tx-async' });
        const res = mock_res();

        wrapped(req, res, vi.fn());
        await vi.waitFor(() => expect(res._body).not.toBeNull());

        expect(handler).toHaveBeenCalledTimes(1);
        expect((res._body as Record<string, unknown>).async).toBe(true);
        expect(_dedup_store.has('tx-async')).toBe(true);
    });
});

// ── GC Lifecycle ─────────────────────────────────────────────────────

describe('dedup GC lifecycle', () => {
    it('start and stop are idempotent', () => {
        start_dedup_gc();
        start_dedup_gc(); // no-op
        stop_dedup_gc();
        stop_dedup_gc(); // no-op
    });
});
