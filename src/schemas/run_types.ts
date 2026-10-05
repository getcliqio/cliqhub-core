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
     * Restrict to runs of this team (any version). Narrowing filter only —
     * the realm-membership gate still applies. May be sent without org_id:
     * the gate then spans the caller's realms in every org.
     */
    team_id: z.string().uuid().optional(),
    /**
     * Organization UUID. Required for org-scoped recent list when
     * realm_id / daemon_id / workspace_id / parent_run_id are omitted.
     * Never invent from X-Org-Id.
     */
    org_id: z.string().uuid().optional().describe(
        'Organization UUID. Required when listing recent runs without realm_id, daemon_id, workspace_id, parent_run_id, or team_id.',
    ),
    /** Substring match on run_id / run_name (POST body only). */
    query: z.string().optional(),
    // Accept a single canonical state OR a list, so the dashboard's
    // "Failed" tile can drill into both `failed` and `crashed` in one
    // request without misleading the count on click-through.
    state: z.union([
        run_state_enum,
        z.array(run_state_enum).min(1),
    ]).optional(),
    since_ms: z.number().optional(),
    all: z.boolean().optional().describe('Site admins only: every record on the hub, not just the caller\'s realm memberships (ignored for everyone else). org_id still narrows.'),
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
    // Team filter: realm gate over all the caller's realms (no org needed).
    if (v.team_id) return;
    // Site-admin hub-wide list (controller ignores `all` for everyone else → 422 there).
    if (v.all) return;
    // Org-scoped recent list — body org_id is invent SoT.
    if (!v.org_id) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'org_id is required when listing recent runs without realm_id, daemon_id, workspace_id, parent_run_id, or team_id',
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

/** Reviewers per human phase chosen at run start: `{ phase: [username] }`. */
export const RunReviewersField = z.record(
    z.string().min(1).max(100),
    z.array(z.string().trim().min(1).max(100)).min(1).max(20),
);

/** Notification channel refs chosen at run start (channel name or id in the run's realm). */
export const RunNotifyChannelsField = z.array(z.string().trim().min(1).max(200)).min(1).max(5);

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
    reviewers: RunReviewersField.optional()
        .describe('Reviewers per human phase for this run: { phase: [username] }; replaces the team defaults for those phases'),
    notify_channels: RunNotifyChannelsField.optional()
        .describe("Notification channels (name or id in the run's realm) that receive this run's lifecycle events instead of the realm rules"),
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

/**
 * Runs API — response Zod schemas (SoT for OpenAPI / Mintlify).
 *
 * Envelope: `{ ok: true, data: T }` (RUN-ENV).
 * One entity DTO for list and get: {@link RunData}.
 */


import type { BooleanData } from '../types/api_response.js';

/** In-flight control command banner payload on run detail. */
export const RunPendingControlData = z.object({
    tx_id: z.string().describe('Command outbox transaction id'),
    endpoint: z.string().describe('Outbox path of the pending control command'),
    enqueued_at: z.number().describe('When the command was queued (unix ms)'),
    attempts: z.number().describe('Delivery attempts so far'),
    max_attempts: z.number().describe('Max delivery attempts before permanent failure'),
    delivered_at: z.number().nullable().describe('When last delivered to daemon (unix ms)'),
    last_error: z.string().nullable().describe('Last delivery error message'),
    ack_status: z.string().nullable().describe('Ack status when partially acked'),
}).describe('Pending cancel/resume/supply_inputs command, if any');
export type RunPendingControlData = z.infer<typeof RunPendingControlData>;

/** Force-terminate eligibility / outcome for the detail banner. */
export const RunForceTerminateData = z.object({
    already_terminated: z.boolean().describe('True when force_terminated_at is set'),
    terminated_at: z.number().nullable().describe('Force-terminate time (unix ms)'),
    terminated_by_user_id: z.string().nullable().describe('User id who force-terminated'),
    terminated_reason: z.string().nullable().describe('Reason string stamped on force-terminate'),
    eligible: z.boolean().describe('Whether force-terminate may be offered now'),
    trigger: z.enum(['stale_cancel', 'daemon_offline', 'lease_expired']).nullable()
        .describe('Which condition tripped eligibility'),
    blocker: z.string().nullable().describe('Human message when not eligible'),
}).describe('Force-terminate UI context');
export type RunForceTerminateData = z.infer<typeof RunForceTerminateData>;

/**
 * Run row on the wire (list + get).
 * Detail-only fields are optional so list rows reuse the same DTO.
 */
export const RunData = z.object({
    run_id: z.string().describe('Hub run id (primary key)'),
    workspace_id: z.string().describe('Workspace UUID'),
    team_id: z.string().describe('Team UUID'),
    daemon_id: z.string().nullable().describe('Daemon id executing the run, or null'),
    realm_id: z.string().nullable().describe('Realm id snapshotted at create'),
    realm_slug: z.string().nullable().optional().describe('Slug of that realm (runs/get list rows)'),
    org_slug: z.string().nullable().optional().describe('Slug of the realm\'s org (runs/get list rows)'),
    parent_run_id: z.string().nullable().describe('Parent run id for nested runs'),
    parent_phase: z.string().nullable().describe('Parent phase that spawned this run'),
    root_run_id: z.string().nullable().describe('Top-level ancestor run id'),
    call_path: z.string().nullable().describe('JSON array of parent phase names'),
    call_depth: z.number().describe('Length of call_path'),
    iteration_key: z.string().nullable().describe('Map iteration key, or null'),
    run_name: z.string().nullable().describe('Optional display name'),
    state: z.string().describe('Lifecycle state (running, completed, failed, …)'),
    inputs: z.unknown().nullable().describe('Run inputs (parsed JSON or raw)'),
    error: z.string().nullable().describe('Terminal error message when failed/crashed'),
    execution_type: z.string().describe('Execution type (e.g. local)'),
    current_pid: z.number().nullable().describe('OS pid of current agent process'),
    current_phase: z.string().nullable().describe('Phase currently executing'),
    external_id: z.string().nullable().describe('External correlation id'),
    context_labels: z.unknown().nullable().describe('Context labels map or JSON string'),
    reviewers: z.record(z.string(), z.array(z.string())).nullable().optional()
        .describe('Reviewers per human phase chosen at run start, or null'),
    notify_channels: z.array(z.string()).nullable().optional()
        .describe('Notification channels chosen at run start for its lifecycle events, or null'),
    lease_expires_at: z.number().nullable().describe('Action lease expiry (unix ms)'),
    started_at: z.number().describe('Start time (unix ms)'),
    completed_at: z.number().nullable().describe('Completion time (unix ms)'),
    team_label: z.string().nullable().optional().describe('Canonical @scope/team label'),
    workspace_name: z.string().nullable().optional().describe('Workspace display name'),
    workspace_dir: z.string().nullable().optional().describe('Workspace absolute path'),
    last_updated_at: z.number().nullable().optional().describe('Best-effort last activity (unix ms)'),
    pending_control: RunPendingControlData.nullable().optional()
        .describe('In-flight control command for the detail banner'),
    force_terminate: RunForceTerminateData.nullable().optional()
        .describe('Force-terminate eligibility / outcome'),
    state_lost_at: z.number().nullable().optional()
        .describe('When daemon reported run_not_found (unix ms)'),
    team_version_id: z.string().nullable().optional()
        .describe('Published team version id when known'),
}).describe('Run resource on the wire');
export type RunData = z.infer<typeof RunData>;

/** Create ack — new run id only. */
export const RunCreateData = z.object({
    run_id: z.string().min(1).describe('Newly created run id'),
});
export type RunCreateData = z.infer<typeof RunCreateData>;

/** Count ack for crash_stale / delete / events_count / artifacts_delete. */
export const RunCountData = z.object({
    count: z.number().int().nonnegative().describe('Rows affected or counted'),
});
export type RunCountData = z.infer<typeof RunCountData>;

/** Single id ack (events_append, create_rdr, handoff). */
export const RunIdData = z.object({
    id: z.string().describe('Created row id'),
});
export type RunIdData = z.infer<typeof RunIdData>;

/** Daemon-pinned dispatch result. */
export const RunDispatchData = z.object({
    run_id: z.string().describe('Run id dispatched'),
    daemon_id: z.string().describe('Target daemon id'),
    accepted: z.boolean().describe('Whether the daemon accepted the execute outbox'),
});
export type RunDispatchData = z.infer<typeof RunDispatchData>;

/** Cancel control result. */
export const RunCancelData = z.object({
    cancelled: z.boolean().describe('True when cancel was accepted or already terminal'),
    mode: z.string().describe('already_terminal | hub_terminated | queued | …'),
}).passthrough();
export type RunCancelData = z.infer<typeof RunCancelData>;

/** User resume-from-phase result. */
export const RunResumeData = z.object({
    resumed: z.boolean().describe('True when resume was queued'),
    from_phase: z.string().describe('Phase to resume from'),
}).passthrough();
export type RunResumeData = z.infer<typeof RunResumeData>;

/** Supply-inputs control result. */
export const RunSupplyInputsData = z.object({
    supplied: z.boolean().describe('True when inputs were queued to the daemon'),
    run_id: z.string().describe('Target run id'),
}).passthrough();
export type RunSupplyInputsData = z.infer<typeof RunSupplyInputsData>;

/** Realm dispatch queue item. */
export const QueueItemData = z.object({
    id: z.string().uuid().describe('Queue item UUID'),
    realm_id: z.string().describe('Realm that owns the queue'),
    kind: z.string().describe('Queue kind (run, install, …)'),
    payload: z.record(z.string(), z.unknown()).describe('Kind-specific payload'),
    priority: z.number().describe('Higher wins claim order'),
    status: z.string().describe('queued | offered | claimed | …'),
    claimed_by: z.string().nullable().describe('Daemon id that claimed, or null'),
    claimed_at: z.number().nullable().describe('Claim time (unix ms)'),
    run_id: z.string().nullable().describe('Linked run id when set'),
    results: z.unknown().nullable().describe('Terminal results payload'),
    submitted_by: z.string().describe('User id that enqueued'),
    submitted_at: z.number().describe('Enqueue time (unix ms)'),
    error: z.string().nullable().describe('Error message when failed'),
    created_at: z.number().describe('Row create time (unix ms)'),
    updated_at: z.number().describe('Row update time (unix ms)'),
}).describe('Realm dispatch queue item');
export type QueueItemData = z.infer<typeof QueueItemData>;

/** Enqueue (realm path) returns the queue item. */
export const RunEnqueueData = z.object({
    item: QueueItemData.describe('Created or offered queue item'),
}).passthrough();
export type RunEnqueueData = z.infer<typeof RunEnqueueData>;

/** Phase row from get_status / update_status reads. */
export const RunPhaseData = z.object({
    run_id: z.string().optional().describe('Owning run id'),
    phase: z.string().describe('Phase name'),
    status: z.string().describe('Phase status'),
    sequence: z.number().optional().describe('Phase order'),
    started_at: z.number().nullable().optional().describe('Phase start (unix ms)'),
    completed_at: z.number().nullable().optional().describe('Phase end (unix ms)'),
    error: z.string().nullable().optional().describe('Phase error'),
    agent: z.string().nullable().optional().describe('Agent name when known'),
}).passthrough().describe('Run phase status row');
export type RunPhaseData = z.infer<typeof RunPhaseData>;

/** Appended run event row. */
export const RunEventData = z.object({
    id: z.string().describe('Event id'),
    run_id: z.string().optional().describe('Owning run id'),
    type: z.string().optional().describe('Event type'),
    event_type: z.string().optional().describe('Legacy event_type alias'),
    phase: z.string().nullable().optional().describe('Phase name'),
    agent: z.string().nullable().optional().describe('Agent name'),
    payload: z.unknown().nullable().optional().describe('Event payload'),
    created_at: z.number().optional().describe('Insert time (unix ms)'),
    timestamp: z.number().optional().describe('Event timestamp (unix ms)'),
}).passthrough().describe('Run event row');
export type RunEventData = z.infer<typeof RunEventData>;

/** Artifact / handoff row. */
export const RunArtifactData = z.object({
    id: z.string().describe('Artifact id'),
    run_id: z.string().optional().describe('Owning run id'),
    phase: z.string().nullable().optional().describe('Producing phase'),
    kind: z.string().optional().describe('Artifact kind'),
    name: z.string().optional().describe('Artifact name'),
    content: z.unknown().optional().describe('Artifact content'),
    target_phase: z.string().nullable().optional().describe('Handoff target phase'),
    sequence: z.number().optional().describe('Order within run'),
}).passthrough().describe('Run artifact row');
export type RunArtifactData = z.infer<typeof RunArtifactData>;

/** Paged run list — SoT for OpenAPI / Mintlify (`POST /v1/runs/get`). */
export const RunPagedData = z.object({
    items: z.array(RunData).describe('Run rows for this page'),
    total: z.number().describe('Total matching rows'),
    offset: z.number().describe('Page offset'),
    limit: z.number().describe('Page size'),
}).describe('Paged RunData list');
export type RunPagedData = z.infer<typeof RunPagedData>;

/**
 * Full runs resource `data` union (documentation aid).
 * Handlers use concrete T — never this union on every call.
 */
export type RunsData =
    | RunData
    | RunData[]
    | RunPagedData
    | RunCreateData
    | RunCountData
    | RunIdData
    | RunDispatchData
    | RunCancelData
    | RunResumeData
    | RunSupplyInputsData
    | RunEnqueueData
    | QueueItemData
    | RunPhaseData[]
    | RunEventData[]
    | RunArtifactData[]
    | BooleanData;
