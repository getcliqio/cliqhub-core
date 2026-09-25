/**
 * Runs API — Zod request schemas (SoT for inbound bodies).
 *
 * Paths under `/v1/runs/*` (RunController). Envelope: flat (RUN-S0 — no `{ ok, data }` yet).
 *
 * Tenancy: org-scoped `get` requires body `org_id` unless a keyed scope is set.
 * Never invent org from X-Org-Id.
 */

import { z } from 'zod';

const run_state_enum = z.enum([
    'running',
    'awaiting_input',
    'completed',
    'failed',
    'cancelled',
    'crashed',
]);

/** POST /v1/runs/get — list runs (org-scoped recent or keyed scope). */
export const RunsGetInput = z.object({
    workspace_id: z.string().optional(),
    parent_run_id: z.string().optional(),
    active_only: z.boolean().optional(),
    limit: z.number().optional(),
    offset: z.number().int().nonnegative().optional(),
    daemon_id: z.string().optional(),
    /** Restrict to runs whose daemon is a member of this realm. */
    realm_id: z.string().optional(),
    /**
     * Organization UUID. Required for org-scoped recent list when
     * realm_id / daemon_id / workspace_id / parent_run_id are omitted.
     * Never invent from X-Org-Id.
     */
    org_id: z.string().uuid().optional().describe(
        'Organization UUID. Required when listing recent runs without realm_id, daemon_id, workspace_id, or parent_run_id.',
    ),
    /** Substring match on run_id / run_name / team label (POST body only). */
    query: z.string().optional(),
    // Accept a single canonical state OR a list, so the dashboard's
    // "Failed" tile can drill into both `failed` and `crashed` in one
    // request without misleading the count on click-through.
    state: z.union([
        run_state_enum,
        z.array(run_state_enum).min(1),
    ]).optional(),
    since_ms: z.number().optional(),
    until_ms: z.number().optional(),
    /** Column to sort by. Default: last_updated_at DESC. */
    sort_by: z.enum(['run_name', 'state', 'team', 'started_at', 'last_updated_at']).optional(),
    sort_dir: z.enum(['asc', 'desc']).optional(),
}).superRefine((v, ctx) => {
    // Keyed scopes bound tenancy without body org_id.
    if (v.parent_run_id?.trim()) return;
    if (v.workspace_id?.trim()) return;
    if (v.realm_id?.trim()) return;
    if (v.daemon_id?.trim()) return;
    // Org-scoped recent list — body org_id is invent SoT.
    if (!v.org_id) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'org_id is required when listing recent runs without realm_id, daemon_id, workspace_id, or parent_run_id',
            path: ['org_id'],
        });
    }
});
export type RunsGetInput = z.infer<typeof RunsGetInput>;

/** POST /v1/runs/get_by_id */
export const RunsGetByIdInput = z.object({
    run_id: z.string(),
});
export type RunsGetByIdInput = z.infer<typeof RunsGetByIdInput>;

export const RunsGetByNameInput = z.object({
    run_name: z.string(),
});
export type RunsGetByNameInput = z.infer<typeof RunsGetByNameInput>;

export const RunsResolveInput = z.object({
    id_or_name: z.string(),
});
export type RunsResolveInput = z.infer<typeof RunsResolveInput>;

/** POST /v1/runs/create */
export const RunsCreateInput = z.object({
    workspace_id: z.string(),
    team_id: z.string(),
    /** Absolute workspace path — used to ensure Hub workspace row on create. */
    workspace_path: z.string().min(1).optional(),
    workspace_name: z.string().nullable().optional(),
    /** Client-provided id (daemon mirror) — Hub generates one when omitted. */
    run_id: z.string().uuid().optional(),
    /**
     * Required. Older daemon builds dropped this field when
     * get_daemon_id() returned empty during a boot race — Hub then
     * wrote `daemon_id: null` and every downstream dispatch endpoint
     * (resume/cancel/supply_inputs) hard-failed with
     * "no daemon assignment" on that run forever. Refuse to accept
     * daemon-less run creates so the daemon operator sees the boot
     * bug at ingest time instead of debugging a dead run later.
     */
    daemon_id: z.string().min(1),
    run_name: z.string().optional(),
    parent_run_id: z.string().optional(),
    parent_phase: z.string().optional(),
    inputs: z.record(z.unknown()).optional(),
    external_id: z.string().max(256).optional(),
    context_labels: z.record(z.string(), z.string()).optional(),
    execution_type: z.string().optional(),
});
export type RunsCreateInput = z.infer<typeof RunsCreateInput>;

/** POST /v1/runs/complete */
export const RunsCompleteInput = z.object({
    run_id: z.string(),
    state: z.enum(['completed', 'failed', 'cancelled', 'crashed']),
    error: z.string().optional(),
});
export type RunsCompleteInput = z.infer<typeof RunsCompleteInput>;

/** POST /v1/runs/resume — daemon mirror (no phase) or user control (optional from_phase). */
export const RunsResumeInput = z.object({
    run_id: z.string().min(1),
    from_phase: z.string().min(1).optional(),
});
export type RunsResumeInput = z.infer<typeof RunsResumeInput>;

/** POST /v1/runs/cancel */
export const RunsCancelInput = z.object({
    run_id: z.string().min(1),
    reason: z.string().max(500).optional(),
});
export type RunsCancelInput = z.infer<typeof RunsCancelInput>;

/** POST /v1/runs/supply_inputs */
export const RunsSupplyInputsInput = z.object({
    run_id: z.string().min(1),
    inputs: z.record(z.unknown()).refine((v) => Object.keys(v).length > 0, {
        message: 'inputs must not be empty',
    }),
});
export type RunsSupplyInputsInput = z.infer<typeof RunsSupplyInputsInput>;

/** POST /v1/runs/enqueue — schedule a run: exactly one of realm_id or daemon_id. */
export const RunsEnqueueInput = z.object({
    realm_id: z.string().min(1).optional(),
    daemon_id: z.string().min(1).optional(),
    team_id: z.string().min(1).optional(),
    workspace_id: z.string().min(1).optional(),
    workspace_path: z.string().optional(),
    manifest_yaml: z.string().optional(),
    run_name: z.string().optional(),
    execution_type: z.enum(['local', 'docker']).optional(),
    priority: z.number().int().optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    run_context: z.object({
        id: z.string().max(256).optional(),
        labels: z.record(z.string(), z.string()).optional(),
        inputs: z.record(z.string(), z.unknown()).optional(),
    }).optional(),
    /** Realm path: flat payload bag (legacy enqueue shape without kind). */
    payload: z.record(z.unknown()).optional(),
}).superRefine((v, ctx) => {
    const has_realm = Boolean(v.realm_id?.trim());
    const has_daemon = Boolean(v.daemon_id?.trim());
    if (has_realm === has_daemon) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Provide exactly one of realm_id or daemon_id',
        });
    }
    if (has_daemon) {
        if (!v.workspace_id?.trim()) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'workspace_id is required when daemon_id is set' });
        }
        if (!v.team_id?.trim()) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'team_id is required when daemon_id is set' });
        }
    }
    if (has_realm) {
        const payload_team = typeof v.payload?.team_id === 'string' ? v.payload.team_id.trim() : '';
        if (!v.team_id?.trim() && !payload_team) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'team_id is required (or payload.team_id)' });
        }
    }
});
export type RunsEnqueueInput = z.infer<typeof RunsEnqueueInput>;

/** POST /v1/runs/claim */
export const RunsClaimInput = z.object({
    queue_item_id: z.string().min(1),
    daemon_id: z.string().min(1),
});
export type RunsClaimInput = z.infer<typeof RunsClaimInput>;

export const RunsQueueGetByIdInput = z.object({
    queue_item_id: z.string().min(1),
});
export type RunsQueueGetByIdInput = z.infer<typeof RunsQueueGetByIdInput>;

export const RunsRestartInput = z.object({
    run_id: z.string(),
});
export type RunsRestartInput = z.infer<typeof RunsRestartInput>;

export const RunsSetCurrentPidInput = z.object({
    run_id: z.string(),
    pid: z.number(),
    phase: z.string(),
});
export type RunsSetCurrentPidInput = z.infer<typeof RunsSetCurrentPidInput>;

export const RunsClearCurrentPidInput = z.object({
    run_id: z.string(),
});
export type RunsClearCurrentPidInput = z.infer<typeof RunsClearCurrentPidInput>;

export const RunsCrashStaleInput = z.object({
    daemon_id: z.string().optional(),
});
export type RunsCrashStaleInput = z.infer<typeof RunsCrashStaleInput>;

export const RunsDeleteByWorkspaceInput = z.object({
    workspace_id: z.string(),
});
export type RunsDeleteByWorkspaceInput = z.infer<typeof RunsDeleteByWorkspaceInput>;

export const RunsEventsAppendInput = z.object({
    run_id: z.string(),
    type: z.string(),
    phase: z.string().optional(),
    agent: z.string().optional(),
    payload: z.unknown().optional(),
});
export type RunsEventsAppendInput = z.infer<typeof RunsEventsAppendInput>;

export const RunsEventsGetInput = z.object({
    run_id: z.string(),
    after: z.string().uuid().optional(),
});
export type RunsEventsGetInput = z.infer<typeof RunsEventsGetInput>;

export const RunsEventsCountInput = z.object({
    run_id: z.string(),
});
export type RunsEventsCountInput = z.infer<typeof RunsEventsCountInput>;

export const RunsEventsDeleteInput = z.object({
    run_id: z.string(),
});
export type RunsEventsDeleteInput = z.infer<typeof RunsEventsDeleteInput>;

/** POST /v1/runs/get_status */
export const RunsGetStatusInput = z.object({
    run_id: z.string(),
    status: z.string().optional(),
});
export type RunsGetStatusInput = z.infer<typeof RunsGetStatusInput>;

/** POST /v1/runs/update_status */
export const RunsUpdateStatusInput = z.object({
    run_id: z.string(),
    phases: z.array(z.object({
        phase: z.string().min(1),
        status: z.string().min(1),
        exit_code: z.number().nullable().optional(),
        error: z.string().nullable().optional(),
        dispatched_at: z.number().nullable().optional(),
        started_at: z.number().nullable().optional(),
    })).min(1),
});
export type RunsUpdateStatusInput = z.infer<typeof RunsUpdateStatusInput>;

/** POST /v1/runs/artifacts/create */
export const RunsArtifactsCreateInput = z.object({
    run_id: z.string(),
    phase: z.string(),
    kind: z.string(),
    name: z.string(),
    content: z.string(),
    mime_type: z.string().optional(),
    target_phase: z.string().optional(),
    sequence: z.number().optional(),
});
export type RunsArtifactsCreateInput = z.infer<typeof RunsArtifactsCreateInput>;

export const RunsArtifactsAppendHandoffInput = z.object({
    run_id: z.string(),
    from_phase: z.string(),
    to_phase: z.string(),
    name: z.string(),
    content: z.string(),
});
export type RunsArtifactsAppendHandoffInput = z.infer<typeof RunsArtifactsAppendHandoffInput>;

export const RunsArtifactsGetInput = z.object({
    run_id: z.string(),
    phase: z.string().optional(),
    kind: z.string().optional(),
    target_phase: z.string().optional(),
});
export type RunsArtifactsGetInput = z.infer<typeof RunsArtifactsGetInput>;

export const RunsArtifactsDeleteInput = z.object({
    run_id: z.string(),
});
export type RunsArtifactsDeleteInput = z.infer<typeof RunsArtifactsDeleteInput>;
