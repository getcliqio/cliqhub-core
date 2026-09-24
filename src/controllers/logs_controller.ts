/**
 * Run logs — append (daemon) and get (SPA / site admin).
 *
 *   POST /v1/runs/append_logs — daemon mirror of run log chunks
 *   POST /v1/runs/get_logs    — realm-scoped search (site admin may omit realm_id)
 *
 * Not telemetry (usage/spans) and not activity (SSE lifecycle rows).
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { RunService } from '../services/run.service.js';
import { RealmService } from '../services/realm.service.js';
import { ApiError } from '../lib/api_error.js';
import { is_site_admin } from '../lib/site_admin.js';

const append_logs_schema = z.object({
    run_id: z.string().min(1),
    chunk: z.string(),
    /**
     * Canonical bucket: 'run' | 'system' | 'command' | 'http'. Defaults
     * to 'run' so pre-migration daemons (no `concern` in payload) keep
     * behaving exactly as before.
     */
    concern: z.string().optional(),
});

const get_logs_schema = z.object({
    /** Omit only for site admins (all-realm search). */
    realm_id: z.string().optional(),
    q: z.string().optional(),
    levels: z.array(z.string()).optional(),
    run_ids: z.array(z.string()).optional(),
    daemon_ids: z.array(z.string()).optional(),
    workspace_ids: z.array(z.string()).optional(),
    teams: z.array(z.string()).optional(),
    /** Whitelist filter: run | system | command | http. Omit to include all. */
    concerns: z.array(z.string()).optional(),
    since_ms: z.number().optional(),
    until_ms: z.number().optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
});

export class LogsController {
    /** POST /v1/runs/append_logs — daemon mirror of run log chunks. */
    static async append_logs(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = append_logs_schema.parse(req.body ?? {});
            const id = await RunService.append_log(body.run_id, body.chunk, {
                concern: body.concern,
            });
            res.json({ ok: true, id });
        } catch (err) {
            next(err);
        }
    }

    /** POST /v1/runs/get_logs — realm-scoped search; site admin may omit realm_id. */
    static async get_logs(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = get_logs_schema.parse(req.body ?? {});
            const user_id = req.user?.user_id?.trim();
            const realm_id = body.realm_id?.trim();
            if (!realm_id) {
                if (!is_site_admin(req)) {
                    throw ApiError.bad_request('realm_id is required');
                }
            } else if (user_id) {
                await RealmService.get(realm_id, user_id);
            }
            const result = await RunService.search_log_lines({
                ...body,
                ...(realm_id ? { realm_id } : {}),
            });
            res.json({
                ok: true,
                lines: result.lines,
                total: result.total,
                facets: result.facets,
                realm: result.realm,
                offset: body.offset ?? 0,
                limit: body.limit ?? 50,
            });
        } catch (err) {
            next(err);
        }
    }
}
