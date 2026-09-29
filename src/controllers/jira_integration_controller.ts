/**
 * JIRA Forge plugin HTTP surface.
 *
 * Accepts EITHER a Bearer session PAT (SPA) OR a body-carried `api_token`
 * (Forge headless). `resolve_caller` prefers session auth; falls back to
 * the body PAT only when `req.auth.user` is absent.
 *
 *   POST /v1/integrations/jira/register_workspace
 *   POST /v1/integrations/jira/rotate_secret
 *   POST /v1/integrations/jira/get_workspaces
 *   POST /v1/integrations/jira/disconnect_workspace
 */

import { BaseController } from './base_controller.js';
import {
    JiraIntegrationService,
    authenticate_jira_pat,
} from '../services/jira_integration.service.js';
import { ApiError } from '../lib/api_error.js';
import type { ApiOkResponse, ApiRequest } from '../types/api_response.js';
import {
    JiraDisconnectWorkspaceInput,
    JiraGetWorkspacesInput,
    JiraRegisterWorkspaceInput,
    JiraRotateSecretInput,
} from '../schemas/jira_integration/types.js';
import type { Request, Response, NextFunction } from 'express';

/**
 * Returns 404 when `ENABLE_JIRA_INTEGRATION` is unset.
 * Mount before every Jira route so a disabled deploy is indistinguishable
 * from a deploy that never mounted these routes.
 */
export function require_jira_enabled(_req: Request, _res: Response, next: NextFunction): void {
    if (!JiraIntegrationService.is_enabled()) {
        next(ApiError.not_found('Unknown API route'));
        return;
    }
    next();
}

export class JiraIntegrationController extends BaseController {
    /**
     * Resolve caller to a user_id. Prefers a Bearer session; falls back to
     * body-carried PAT for Forge headless callers. Throws 401 when neither
     * yields a valid user.
     */
    private async resolve_caller(req: Request, body: { api_token?: string }): Promise<string> {
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

    /**
     * Bind a Jira workspace to a realm and seed 7 lifecycle notification rules.
     * Idempotent: re-registering the same (realm_id, workspace_id) tuple returns
     * the existing subscription_id without a new secret.
     *
     * @param req - Body: {@link JiraRegisterWorkspaceInput}
     * @param res - `{ ok: true, data: { subscription_id, webhook_secret?, realm_id, workspace_id, cliq_user } }`
     */
    async register_workspace(req: ApiRequest<JiraRegisterWorkspaceInput>, res: ApiOkResponse<unknown>): Promise<void> {
        const body = this.parse_body(JiraRegisterWorkspaceInput, req);
        const user_id = await this.resolve_caller(req, body);
        const result = await JiraIntegrationService.register(user_id, body);
        this.ok(res, result);
    }

    /**
     * Rotate the webhook secret for an existing (realm_id, workspace_id) binding.
     * The previous secret is immediately invalidated.
     *
     * @param req - Body: {@link JiraRotateSecretInput}
     * @param res - `{ ok: true, data: { secret: string } }`
     */
    async rotate_secret(req: ApiRequest<JiraRotateSecretInput>, res: ApiOkResponse<{ secret: string }>): Promise<void> {
        const body = this.parse_body(JiraRotateSecretInput, req);
        const user_id = await this.resolve_caller(req, body);
        const result = await JiraIntegrationService.rotate_secret(user_id, body);
        this.ok(res, { secret: result.secret });
    }

    /**
     * List all Jira workspace bindings visible to the caller.
     * Returns one row per (admin realm × Jira binding); realms with no
     * binding surface as a single row with null workspace fields.
     *
     * @param req - Body: {@link JiraGetWorkspacesInput}
     * @param res - `{ ok: true, data: { workspaces: JiraBinding[] } }`
     */
    async get_workspaces(req: ApiRequest<JiraGetWorkspacesInput>, res: ApiOkResponse<unknown>): Promise<void> {
        const body = this.parse_body(JiraGetWorkspacesInput, req);
        const user_id = await this.resolve_caller(req, body);
        const workspaces = await JiraIntegrationService.list_channels(user_id);
        this.ok(res, { workspaces });
    }

    /**
     * Remove a (realm_id, workspace_id) binding and its notification rules.
     * Idempotent: returns `removed: false` when no binding exists rather than 404.
     *
     * @param req - Body: {@link JiraDisconnectWorkspaceInput}
     * @param res - `{ ok: true, data: { removed: boolean } }`
     */
    async disconnect_workspace(req: ApiRequest<JiraDisconnectWorkspaceInput>, res: ApiOkResponse<unknown>): Promise<void> {
        const body = this.parse_body(JiraDisconnectWorkspaceInput, req);
        const user_id = await this.resolve_caller(req, body);
        const result = await JiraIntegrationService.disconnect(user_id, body);
        this.ok(res, result);
    }
}
