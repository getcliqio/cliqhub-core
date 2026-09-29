import { z } from 'zod';

/**
 * Lightweight run reference embedded in workspace responses.
 */
export const WorkspaceRunRef = z.object({
    run_id: z.string().uuid()
        .describe('Run UUID'),
    state: z.string()
        .describe('Run state slug'),
    started_at: z.number()
        .describe('Epoch ms when the run started'),
});

export type WorkspaceRunRef = z.infer<typeof WorkspaceRunRef>;

/**
 * Team reference embedded in workspace responses.
 */
export const WorkspaceTeamRef = z.object({
    team_id: z.string().uuid()
        .describe('Team UUID'),
    slug: z.string()
        .describe('Team slug (scope/name)'),
    scope: z.string()
        .describe('Scope slug'),
    assembled_at: z.string().nullable().optional()
        .describe('ISO timestamp of last assembly; null if not yet assembled'),
});

export type WorkspaceTeamRef = z.infer<typeof WorkspaceTeamRef>;

/**
 * Canonical wire shape for a workspace (list item + detail).
 * Replaces inline workspace shapes in workspaces_controller.ts and SPA.
 * Timestamps are epoch ms (matching workspace.service.ts).
 */
export const WorkspaceData = z.object({
    id: z.string().uuid()
        .describe('Workspace UUID (same as workspace_id)'),
    path: z.string()
        .describe('Absolute filesystem path of the workspace directory'),
    name: z.string().nullable()
        .describe('Human-assigned workspace name; null when not set'),
    assembled: z.boolean()
        .describe('True if the workspace has been fully assembled'),
    daemon_id: z.string().nullable()
        .describe('Daemon UUID managing this workspace; null if unassigned'),
    teams: z.array(WorkspaceTeamRef)
        .describe('Teams installed in this workspace'),
    active_runs: z.array(WorkspaceRunRef)
        .describe('Runs currently in progress'),
    latest_run: WorkspaceRunRef.nullable()
        .describe('Most recent run (any state); null if no runs'),
    created_at: z.number()
        .describe('Epoch ms of workspace registration'),
    updated_at: z.number()
        .describe('Epoch ms of last update'),
});

export type WorkspaceData = z.infer<typeof WorkspaceData>;
