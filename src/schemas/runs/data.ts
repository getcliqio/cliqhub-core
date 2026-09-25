/**
 * Runs API — response Zod schemas (SoT for OpenAPI / Mintlify).
 *
 * Envelope: `{ ok: true, data: T }` (RUN-ENV).
 * One entity DTO for list and get: {@link RunData}.
 */

import { z } from 'zod';

import type { BooleanData } from '../../types/api_response.js';

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

/** Single id ack (events_append, artifacts_create, handoff). */
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
