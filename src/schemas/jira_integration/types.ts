/**
 * JIRA integration request schemas.
 *
 * All endpoints accept EITHER a Bearer session PAT OR a body-carried
 * `api_token` (for Forge headless callers). The controller resolves
 * the caller in `resolve_caller` — session auth takes precedence.
 *
 * Paths:
 *   POST /v1/integrations/jira/register_workspace
 *   POST /v1/integrations/jira/rotate_secret
 *   POST /v1/integrations/jira/get_workspaces
 *   POST /v1/integrations/jira/disconnect_workspace
 */

import { z } from 'zod';

/** POST /v1/integrations/jira/register_workspace — bind a Jira workspace to a realm. */
export const JiraRegisterWorkspaceInput = z.object({
    api_token: z.string().min(1).optional().describe('Forge headless PAT; ignored when session Bearer is present'),
    realm_id: z.string().min(1).describe('Realm to bind the workspace to'),
    webhook_url: z.string().url().describe('Jira webhook delivery URL'),
    workspace_id: z.string().min(1).max(128).describe('Atlassian workspace/cloud ID'),
    workspace_url: z.string().url().describe('Base URL of the Jira workspace (e.g. https://acme.atlassian.net)'),
});
export type JiraRegisterWorkspaceInput = z.infer<typeof JiraRegisterWorkspaceInput>;

/** POST /v1/integrations/jira/rotate_secret — mint a new webhook secret for a binding. */
export const JiraRotateSecretInput = z.object({
    api_token: z.string().min(1).optional().describe('Forge headless PAT; ignored when session Bearer is present'),
    realm_id: z.string().min(1).describe('Realm the binding belongs to'),
    workspace_id: z.string().min(1).max(128).describe('Atlassian workspace/cloud ID'),
});
export type JiraRotateSecretInput = z.infer<typeof JiraRotateSecretInput>;

/** POST /v1/integrations/jira/get_workspaces — list all bindings visible to the caller. */
export const JiraGetWorkspacesInput = z.object({
    api_token: z.string().min(1).optional().describe('Forge headless PAT; ignored when session Bearer is present'),
});
export type JiraGetWorkspacesInput = z.infer<typeof JiraGetWorkspacesInput>;

/** POST /v1/integrations/jira/disconnect_workspace — remove a (realm, workspace) binding. */
export const JiraDisconnectWorkspaceInput = z.object({
    api_token: z.string().min(1).optional().describe('Forge headless PAT; ignored when session Bearer is present'),
    realm_id: z.string().min(1).describe('Realm the binding belongs to'),
    workspace_id: z.string().min(1).max(128).describe('Atlassian workspace/cloud ID'),
});
export type JiraDisconnectWorkspaceInput = z.infer<typeof JiraDisconnectWorkspaceInput>;
