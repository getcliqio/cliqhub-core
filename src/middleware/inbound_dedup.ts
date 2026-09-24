/**
 * Inbound dedup middleware for daemon → Hub control endpoints.
 *
 * Every daemon→Hub state-changing request includes a `tx_id` in the body.
 * This middleware:
 *   1. Rejects requests without `tx_id` (400).
 *   2. Checks the `inbound_dedup` table for a cached response.
 *   3. If found: returns the cached response (no handler execution).
 *   4. If miss: runs the handler, caches the result, returns it.
 *
 * The dedup record write is best-effort: if the INSERT fails (PK
 * conflict from a concurrent request), the handler itself is idempotent,
 * so re-execution on a missed cache is safe.
 */

import type { Request, Response, NextFunction } from 'express';

import { get_control_plane_store } from '../db/control_plane_store.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('inbound-dedup');

/** Cache retention before GC prunes (7 days). */
const RETENTION_DAYS = 7;

// ── Types ────────────────────────────────────────────────────────────

interface DedupRow {
    readonly tx_id: string;
    readonly endpoint: string;
    readonly status_code: number;
    readonly response: unknown; // JSONB — auto-parsed by Sequelize/pg driver
    readonly created_at: number;
}

// ── Middleware Factory ────────────────────────────────────────────────

/**
 * Wrap an Express route handler with idempotent dedup.
 *
 * Usage in routes.ts:
 *   router.post('/runs/create', auth, with_dedup(RunController.create));
 */
export function with_dedup(
    handler: (req: Request, res: Response, next: NextFunction) => void | Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction) => {
        _handle_dedup(handler, req, res, next).catch(next);
    };
}

async function _handle_dedup(
    handler: (req: Request, res: Response, next: NextFunction) => void | Promise<void>,
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    const tx_id = req.body?.tx_id;

    // tx_id is mandatory on all dedup-wrapped endpoints.
    if (!tx_id || typeof tx_id !== 'string') {
        res.status(400).json({ ok: false, error: 'tx_id is required' });
        return;
    }

    // Check cache.
    const cached = await _lookup(tx_id);
    if (cached) {
        log.debug('dedup_cache_hit', { tx_id, endpoint: cached.endpoint });
        // `response` is JSONB — Sequelize/pg auto-parses it into an object.
        // If the column is ever TEXT, fall back to JSON.parse.
        const body = typeof cached.response === 'string'
            ? JSON.parse(cached.response)
            : cached.response;
        res.status(cached.status_code).json(body);
        return;
    }

    // Cache miss — execute the real handler and capture the response.
    const endpoint = req.originalUrl || req.url;
    const captured = await _capture_response(handler, req, res, next);

    // If the handler errored (next(err) was called), we don't cache.
    if (!captured) return;

    // Best-effort record — PK conflict is harmless.
    await _record(tx_id, endpoint, captured.status_code, captured.body);

    log.debug('dedup_cache_miss', { tx_id, endpoint, status: captured.status_code });
}

// ── Response Capture ─────────────────────────────────────────────────

interface CapturedResponse {
    readonly status_code: number;
    readonly body: unknown;
}

/**
 * Execute the handler while intercepting res.json() to capture the
 * response body and status code. Returns null if the handler called
 * next(err) instead of res.json().
 */
async function _capture_response(
    handler: (req: Request, res: Response, next: NextFunction) => void | Promise<void>,
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<CapturedResponse | null> {
    return new Promise<CapturedResponse | null>((resolve) => {
        let resolved = false;

        // Monkey-patch res.json to capture the output.
        const original_json = res.json.bind(res);
        res.json = function (body: unknown) {
            if (!resolved) {
                resolved = true;
                resolve({ status_code: res.statusCode, body });
            }
            return original_json(body);
        } as typeof res.json;

        // Wrap next to detect error-path exits.
        const wrapped_next: NextFunction = (err?: unknown) => {
            if (!resolved) {
                resolved = true;
                resolve(null);
            }
            next(err);
        };

        // Run the handler.
        const maybe_promise = handler(req, res, wrapped_next);
        if (maybe_promise instanceof Promise) {
            maybe_promise.catch((err: unknown) => {
                if (!resolved) {
                    resolved = true;
                    resolve(null);
                }
                next(err);
            });
        }
    });
}

// ── Database Operations ──────────────────────────────────────────────

/** Look up a cached response by tx_id. */
async function _lookup(tx_id: string): Promise<DedupRow | null> {
    try {
        const store = get_control_plane_store();
        const [rows] = await store.sequelize.query(
            `SELECT tx_id, endpoint, status_code, response, created_at
             FROM cliq.inbound_dedup
             WHERE tx_id = ?`,
            { replacements: [tx_id] },
        );
        const arr = rows as DedupRow[];
        return arr.length > 0 ? arr[0] : null;
    } catch {
        // Table may not exist yet during rolling deploy — treat as miss.
        return null;
    }
}

/** Record a response for future dedup. Best-effort — PK conflict is fine. */
async function _record(
    tx_id: string,
    endpoint: string,
    status_code: number,
    body: unknown,
): Promise<void> {
    try {
        const store = get_control_plane_store();
        await store.sequelize.query(
            `INSERT INTO cliq.inbound_dedup (tx_id, endpoint, status_code, response, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (tx_id) DO NOTHING`,
            { replacements: [tx_id, endpoint, status_code, JSON.stringify(body), Date.now()] },
        );
    } catch (err) {
        // Best-effort: log and continue.
        log.warn('dedup_record_failed', {
            tx_id,
            endpoint,
            error: (err as Error).message,
        });
    }
}

// ── Garbage Collection ───────────────────────────────────────────────

let _gc_timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start hourly GC to prune old dedup entries.
 * Called once on Hub boot alongside run_reaper.
 */
export function start_dedup_gc(): void {
    if (_gc_timer) return;
    _gc_timer = setInterval(() => void _run_gc(), 60 * 60 * 1_000);
    log.info('dedup_gc_started');
}

/** Stop GC (for shutdown / tests). */
export function stop_dedup_gc(): void {
    if (_gc_timer) {
        clearInterval(_gc_timer);
        _gc_timer = null;
    }
}

/** Stats for the Hub health endpoint. */
export async function get_dedup_stats(): Promise<{ inbound_dedup_count: number }> {
    try {
        const store = get_control_plane_store();
        const [rows] = await store.sequelize.query(
            `SELECT COUNT(*) as cnt FROM cliq.inbound_dedup`,
        ) as unknown as [Array<{ cnt: string }>];
        return { inbound_dedup_count: parseInt(rows?.[0]?.cnt ?? '0', 10) };
    } catch {
        return { inbound_dedup_count: 0 };
    }
}

/** Delete dedup entries older than retention. */
async function _run_gc(): Promise<void> {
    const cutoff = Date.now() - (RETENTION_DAYS * 24 * 60 * 60 * 1_000);
    try {
        const store = get_control_plane_store();
        await store.sequelize.query(
            `DELETE FROM cliq.inbound_dedup WHERE created_at < ?`,
            { replacements: [cutoff] },
        );
        log.debug('dedup_gc_complete');
    } catch (err) {
        log.warn('dedup_gc_failed', { error: (err as Error).message });
    }
}
