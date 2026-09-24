import type { Request, Response, NextFunction } from 'express';

/**
 * Send `Cache-Control: no-store` on the response.
 *
 * Applied to team read endpoints (`get_by_id`, `get_version`,
 * `get_versions`, `batch_latest`) so the SPA's Run dialog never
 * shows a stale input schema after a fresh publish. Symptom this
 * prevents: user publishes v2.0.0 (which added/removed inputs),
 * clicks "Run", and sees v1.x's input fields because the browser
 * (or a Cloudflare edge) served a cached POST response body.
 *
 * These are cheap reads that already vary with the catalog, so
 * disabling caching costs us nothing and closes the confusion window.
 * (Publish itself already invalidates the DB row; this closes the
 * remaining client-side hop.)
 */
export function no_store(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cache-Control', 'no-store');
    next();
}
