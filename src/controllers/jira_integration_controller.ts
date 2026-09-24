/**
 * JIRA Forge plugin HTTP surface (slice 1.5).
 *
 * Accepts EITHER a JWT session (SPA, cookie → Bearer) OR a body-carried
 * PAT (`api_token`, for Forge and other headless clients). The
 * controller resolves the caller to a user_id in `_resolve_caller`, and
 * the service takes only `user_id`. Session auth is checked first — if
 * `req.auth.user` is present the body's `api_token` is ignored.
 *
 * Route-level gated by `ENABLE_JIRA_INTEGRATION`; when the flag is
 * unset the routes 404 so probes can't distinguish "not built yet"
 * from "not enabled here".
 *
 *   POST /v1/integrations/jira/register        — bind workspace to realm
 *   POST /v1/integrations/jira/rotate_secret   — mint a new webhook secret
 *   POST /v1/integrations/jira/list_realms     — realms the caller admins
 *   POST /v1/integrations/jira/list            — per-realm binding table
 *   POST /v1/integrations/jira/disconnect      — remove binding from realm
 *
 * See DESIGN-jira-forge-plugin slice 1.5.
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import {
    JiraIntegrationService,
    authenticate_jira_pat,
} from '../services/jira_integration.service.js';
import { ApiError } from '../lib/api_error.js';

// api_token is optional at the schema layer — presence is checked in
// _resolve_caller only when session auth failed to produce a user id.
const register_schema = z.object({
    api_token: z.string().min(1).optional(),
    realm_id: z.string().min(1),
    webhook_url: z.string().url(),
    workspace_id: z.string().min(1).max(128),
    workspace_url: z.string().url(),
});

const rotate_schema = z.object({
    api_token: z.string().min(1).optional(),
    realm_id: z.string().min(1),
    workspace_id: z.string().min(1).max(128),
});

const list_realms_schema = z.object({
    api_token: z.string().min(1).optional(),
});

const list_channels_schema = z.object({
    api_token: z.string().min(1).optional(),
});

const disconnect_schema = z.object({
    api_token: z.string().min(1).optional(),
    realm_id: z.string().min(1),
    workspace_id: z.string().min(1).max(128),
});

/**
 * Resolve the caller to a user_id. Prefers a JWT session (SPA); falls
 * back to a body-carried PAT (Forge). Throws 401 when neither yields
 * a valid user.
 */
async function _resolve_caller(req: Request, body: { api_token?: string }): Promise<string> {
    const session_user = req.auth?.user;
    if (session_user?.id != null) {
        return String(session_user.id);
    }
    if (!body.api_token) {
        throw ApiError.unauthorized('missing api_token');
    }
    const { user_id } = await authenticate_jira_pat(body.api_token);
    return user_id;
}

export class JiraIntegrationController {

    static async register(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = register_schema.parse(req.body);
            const user_id = await _resolve_caller(req, body);
            const result = await JiraIntegrationService.register(user_id, body);
            res.json({ ok: true, ...result });
        } catch (err) { next(err); }
    }

    static async rotate_secret(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = rotate_schema.parse(req.body);
            const user_id = await _resolve_caller(req, body);
            const result = await JiraIntegrationService.rotate_secret(user_id, body);
            res.json({ ok: true, secret: result.secret });
        } catch (err) { next(err); }
    }

    static async list_realms(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = list_realms_schema.parse(req.body ?? {});
            const user_id = await _resolve_caller(req, body);
            const realms = await JiraIntegrationService.list_realms(user_id);
            res.json({ ok: true, realms });
        } catch (err) { next(err); }
    }

    static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = list_channels_schema.parse(req.body ?? {});
            const user_id = await _resolve_caller(req, body);
            const rows = await JiraIntegrationService.list_channels(user_id);
            res.json({ ok: true, bindings: rows });
        } catch (err) { next(err); }
    }

    static async disconnect(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = disconnect_schema.parse(req.body);
            const user_id = await _resolve_caller(req, body);
            const result = await JiraIntegrationService.disconnect(user_id, body);
            res.json({ ok: true, ...result });
        } catch (err) { next(err); }
    }

    /**
     * Route-level gate: 404 when ENABLE_JIRA_INTEGRATION is unset.
     * Sits before every JIRA handler so a disabled deploy looks
     * exactly like the routes were never mounted.
     */
    static gate(req: Request, res: Response, next: NextFunction): void {
        if (!JiraIntegrationService.is_enabled()) {
            next(ApiError.not_found('Unknown API route'));
            return;
        }
        next();
    }
}
