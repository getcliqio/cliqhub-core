import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { RunService } from '../services/run.service.js';
import { DispatchService } from '../services/dispatch.service.js';
import { QueueService } from '../services/queue.service.js';
import { RealmService } from '../services/realm.service.js';
import { ApiError } from '../lib/api_error.js';


// --- Core run schemas ---
const get_schema = z.object({
    workspace_id: z.string().optional(),
    parent_run_id: z.string().optional(),
    active_only: z.boolean().optional(),
    limit: z.number().optional(),
    offset: z.number().int().nonnegative().optional(),
    daemon_id: z.string().optional(),
    /** Restrict to runs whose daemon is a member of this realm. */
    realm_id: z.string().optional(),
    /** Substring match on run_id / run_name / team label (POST body only). */
    query: z.string().optional(),
    // Accept a single canonical state OR a list, so the dashboard's
    // "Failed" tile can drill into both `failed` and `crashed` in one
    // request without misleading the count on click-through.
    state: z.union([
        z.enum(['running', 'awaiting_input', 'completed', 'failed', 'cancelled', 'crashed']),
        z.array(z.enum(['running', 'awaiting_input', 'completed', 'failed', 'cancelled', 'crashed'])).min(1),
    ]).optional(),
    since_ms: z.number().optional(),
    until_ms: z.number().optional(),
    /** Column to sort by. Default: last_updated_at DESC. */
    sort_by: z.enum(['run_name', 'state', 'team', 'started_at', 'last_updated_at']).optional(),
    sort_dir: z.enum(['asc', 'desc']).optional(),
}).optional();

const get_by_id_schema = z.object({ run_id: z.string() });
const get_by_name_schema = z.object({ run_name: z.string() });
const resolve_schema = z.object({ id_or_name: z.string() });

const create_schema = z.object({
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

const complete_schema = z.object({
    run_id: z.string(),
    state: z.enum(['completed', 'failed', 'cancelled', 'crashed']),
    error: z.string().optional(),
});

/** Daemon mirror (no phase) or user control (optional from_phase → daemon outbox). */
const resume_schema = z.object({
    run_id: z.string().min(1),
    from_phase: z.string().min(1).optional(),
});
const cancel_run_schema = z.object({
    run_id: z.string().min(1),
    reason: z.string().max(500).optional(),
});
const supply_inputs_schema = z.object({
    run_id: z.string().min(1),
    inputs: z.record(z.unknown()).refine((v) => Object.keys(v).length > 0, {
        message: 'inputs must not be empty',
    }),
});

/** Schedule a run: exactly one of realm_id (fleet claim) or daemon_id (pin). */
const enqueue_run_schema = z.object({
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

const claim_queue_schema = z.object({
    queue_item_id: z.string().min(1),
    daemon_id: z.string().min(1),
});

const queue_get_by_id_schema = z.object({
    queue_item_id: z.string().min(1),
});

const restart_schema = z.object({ run_id: z.string() });
const set_current_pid_schema = z.object({ run_id: z.string(), pid: z.number(), phase: z.string() });
const clear_current_pid_schema = z.object({ run_id: z.string() });
const crash_stale_schema = z.object({ daemon_id: z.string().optional() }).optional();
const delete_by_workspace_schema = z.object({ workspace_id: z.string() });

// --- Events schemas ---
const events_append_schema = z.object({
    run_id: z.string(),
    type: z.string(),
    phase: z.string().optional(),
    agent: z.string().optional(),
    payload: z.unknown().optional(),
});
const events_get_schema = z.object({
    run_id: z.string(),
    after: z.string().uuid().optional(),
});
const events_count_schema = z.object({ run_id: z.string() });
const events_delete_schema = z.object({ run_id: z.string() });

// --- Run status (phase runtime) — hard-cut from /v1/runs/phases/* ---
const get_status_schema = z.object({
    run_id: z.string(),
    status: z.string().optional(),
});
const update_status_schema = z.object({
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

// --- Artifacts schemas ---
const artifacts_create_schema = z.object({
    run_id: z.string(),
    phase: z.string(),
    kind: z.string(),
    name: z.string(),
    content: z.string(),
    mime_type: z.string().optional(),
    target_phase: z.string().optional(),
    sequence: z.number().optional(),
});
const artifacts_append_handoff_schema = z.object({
    run_id: z.string(),
    from_phase: z.string(),
    to_phase: z.string(),
    name: z.string(),
    content: z.string(),
});
const artifacts_get_schema = z.object({
    run_id: z.string(),
    phase: z.string().optional(),
    kind: z.string().optional(),
    target_phase: z.string().optional(),
});
const artifacts_delete_schema = z.object({ run_id: z.string() });

export class RunController {
    // --- Core run methods ---

    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const filters = get_schema.parse(req.body);
            if (filters?.parent_run_id) {
                const runs = await RunService.list_children(filters.parent_run_id);
                res.json({ ok: true, runs });
                return;
            }
            if (filters?.active_only && filters.workspace_id) {
                const runs = await RunService.list_active(filters.workspace_id);
                res.json({ ok: true, runs });
                return;
            }
            if (filters?.workspace_id) {
                const result = await RunService.list_by_workspace(
                    filters.workspace_id,
                    filters.limit,
                    filters.offset,
                );
                res.json({
                    ok: true,
                    runs: result.runs,
                    total: result.total,
                    offset: filters.offset ?? 0,
                    limit: filters.limit ?? 50,
                });
                return;
            }
            const result = await RunService.list_recent(
                filters?.limit,
                filters?.daemon_id,
                {
                    query: filters?.query,
                    state: filters?.state,
                    realm_id: filters?.realm_id,
                    offset: filters?.offset,
                    since_ms: filters?.since_ms,
                    until_ms: filters?.until_ms,
                    user_id: req.user?.user_id,
                    // Org gate: the X-Org-Id header is the primary filter
                    // in the UI (org switcher). Without this the home
                    // dashboard shows runs from every org the user has
                    // touched, which contradicts what the top-bar says.
                    org_id: req.user?.current_org_id,
                    sort_by: filters?.sort_by,
                    sort_dir: filters?.sort_dir,
                },
            );
            res.json({
                ok: true,
                runs: result.runs,
                total: result.total,
                offset: filters?.offset ?? 0,
                limit: filters?.limit ?? 20,
            });
        } catch (err) { next(err); }
    }

    static async get_by_id(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id } = get_by_id_schema.parse(req.body);
            const run = await RunService.get(run_id);
            if (!run) {
                res.json({ ok: true, run: null });
                return;
            }
            // Enrich with any in-flight control command targeting
            // this run. The run detail page reads this to render a
            // persistent "cancel queued — waiting on daemon" banner
            // and disable the Cancel button. Kept out of the raw
            // service getter so we don't change its return shape for
            // the many callers that consume the Sequelize instance
            // directly.
            const daemon_id = (run.get('daemon_id') as string | null) ?? null;
            const [pending_control, force_status, state_lost_at, team_version_id] = await Promise.all([
                RunService.load_pending_control(daemon_id, run_id),
                // Force-terminate context: whether the button should
                // be offered on the banner (eligibility + trigger)
                // AND whether the run has already been force-cancelled
                // (banner flips to "Force cancelled by @X").
                RunService.load_force_terminate_status(run_id, daemon_id),
                // Orphan status: set when a dispatched command came
                // back from the daemon with `run_not_found`. Presence
                // of this timestamp flips the detail page from "Resume"
                // to "Run again" as the only meaningful action.
                RunService.load_state_lost_at(run_id),
                RunService.load_team_version_id(run_id),
            ]);
            const payload = {
                ...(run.toJSON() as unknown as Record<string, unknown>),
                pending_control,
                force_terminate: force_status,
                state_lost_at,
                team_version_id,
            };
            res.json({ ok: true, run: payload });
        } catch (err) { next(err); }
    }

    static async get_by_name(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_name } = get_by_name_schema.parse(req.body);
            const run = await RunService.get_by_name(run_name);
            res.json({ ok: true, run });
        } catch (err) { next(err); }
    }

    static async resolve(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { id_or_name } = resolve_schema.parse(req.body);
            const run = await RunService.resolve(id_or_name);
            res.json({ ok: true, run });
        } catch (err) { next(err); }
    }

    static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = create_schema.parse(req.body);
            const run_id = await RunService.create(data.workspace_id, data.team_id, {
                run_id: data.run_id,
                daemon_id: data.daemon_id,
                workspace_path: data.workspace_path,
                workspace_name: data.workspace_name,
                run_name: data.run_name,
                parent_run_id: data.parent_run_id,
                parent_phase: data.parent_phase,
                inputs: data.inputs,
                external_id: data.external_id,
                context_labels: data.context_labels,
                execution_type: data.execution_type,
            });
            res.json({ ok: true, run_id });
        } catch (err) { next(err); }
    }

    static async complete(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id, state, error } = complete_schema.parse(req.body);
            await RunService.complete(run_id, state, error);
            res.json({ ok: true });
        } catch (err) { next(err); }
    }

    /**
     * POST /v1/runs/resume
     * - Daemon mirror: `{ run_id }` → Hub state awaiting_input → running
     * - User control: `{ run_id, from_phase }` → outbox resume to daemon
     */
    static async resume(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id, from_phase } = resume_schema.parse(req.body);
            if (from_phase) {
                const result = await DispatchService.resume(
                    run_id,
                    from_phase,
                    req.user?.org_ids ?? [],
                    req.user?.user_id,
                );
                res.json({ ok: true, ...result });
                return;
            }
            await RunService.resume(run_id);
            res.json({ ok: true });
        } catch (err) { next(err); }
    }

    static async cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id, reason } = cancel_run_schema.parse(req.body);
            const result = await DispatchService.cancel_run(
                run_id,
                req.user?.org_ids ?? [],
                req.user?.user_id,
                reason,
            );
            res.json({ ok: true, ...result });
        } catch (err) { next(err); }
    }

    static async supply_inputs(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = supply_inputs_schema.parse(req.body);
            const result = await DispatchService.supply_inputs({
                run_id: data.run_id,
                inputs: data.inputs,
                user_id: req.user?.user_id ?? '',
            });
            res.json({ ok: true, ...result });
        } catch (err) { next(err); }
    }

    /**
     * POST /v1/runs/enqueue — schedule a run (Slice 2).
     * - realm_id → exclusive offer/claim (former dispatch/enqueue kind=run)
     * - daemon_id → pinned execute (former dispatch/run)
     */
    static async enqueue(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = enqueue_run_schema.parse(req.body ?? {});
            const user_id = req.user?.user_id ?? '';
            const org_ids = req.user?.org_ids ?? [];
            const scope_ids = req.user?.scope_ids ?? [];

            if (data.daemon_id) {
                const run_context = {
                    ...(data.run_context ?? {}),
                    inputs: {
                        ...(data.run_context?.inputs ?? {}),
                        ...(data.inputs ?? {}),
                    },
                };
                const result = await DispatchService.dispatch_run({
                    workspace_id: data.workspace_id!,
                    team_id: data.team_id!,
                    daemon_id: data.daemon_id,
                    realm_id: data.realm_id,
                    workspace_path: data.workspace_path,
                    manifest_yaml: data.manifest_yaml,
                    run_context,
                    run_name: data.run_name,
                    execution_type: data.execution_type,
                    org_ids,
                    user_id,
                    scope_ids,
                });
                res.json({ ok: true, ...result });
                return;
            }

            const payload: Record<string, unknown> = { ...(data.payload ?? {}) };
            if (data.team_id) payload.team_id = data.team_id;
            if (data.workspace_id) payload.workspace_id = data.workspace_id;
            if (data.workspace_path) payload.workspace_path = data.workspace_path;
            if (data.manifest_yaml) payload.manifest_yaml = data.manifest_yaml;
            if (data.run_name) payload.run_name = data.run_name;
            if (data.execution_type) payload.execution_type = data.execution_type;
            const inputs = {
                ...((payload.inputs && typeof payload.inputs === 'object' && !Array.isArray(payload.inputs))
                    ? payload.inputs as Record<string, unknown>
                    : {}),
                ...(data.inputs ?? {}),
                ...(data.run_context?.inputs ?? {}),
            };
            if (Object.keys(inputs).length > 0) payload.inputs = inputs;
            if (data.run_context) {
                payload.run_context = {
                    ...data.run_context,
                    inputs: {
                        ...(data.run_context.inputs ?? {}),
                        ...inputs,
                    },
                };
            }

            const result = await DispatchService.enqueue({
                realm_id: data.realm_id!,
                kind: 'run',
                payload,
                priority: data.priority,
                user_id,
                scope_ids,
                org_ids,
            });
            res.json({ ok: true, ...result });
        } catch (err) { next(err); }
    }

    /** POST /v1/runs/claim — daemon (or member) claims an exclusive queue item. */
    static async claim(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = claim_queue_schema.parse(req.body);
            const item = await QueueService.get(data.queue_item_id);

            if (req.auth?.auth_via === 'daemon_token') {
                const realm_id = req.auth.realm_id;
                if (!realm_id) throw ApiError.forbidden('Daemon token has no primary realm');
                if (realm_id !== item.realm_id) {
                    throw ApiError.forbidden('Daemon token realm does not match queue item');
                }
                await RealmService.assert_daemon_in_realm(item.realm_id, data.daemon_id);
            } else {
                const user_id = req.user?.user_id ?? '';
                if (!user_id) throw ApiError.forbidden('Not authenticated');
                await RealmService.assert_member(item.realm_id, user_id);
            }

            const claimed = await QueueService.claim(data.queue_item_id, data.daemon_id);
            res.json({ ok: true, item: claimed });
        } catch (err) { next(err); }
    }

    /** POST /v1/runs/queue/get_by_id — ops/debug status for one queue row. */
    static async queue_get_by_id(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { queue_item_id } = queue_get_by_id_schema.parse(req.body);
            const user_id = req.user?.user_id ?? '';
            if (!user_id) throw ApiError.forbidden('Not authenticated');

            const item = await QueueService.get(queue_item_id);
            await RealmService.assert_member(item.realm_id, user_id);
            res.json({ ok: true, item });
        } catch (err) { next(err); }
    }

    static async restart(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id } = restart_schema.parse(req.body);
            await RunService.restart(run_id);
            res.json({ ok: true });
        } catch (err) { next(err); }
    }

    static async set_current_pid(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id, pid, phase } = set_current_pid_schema.parse(req.body);
            await RunService.set_current_pid(run_id, pid, phase);
            res.json({ ok: true });
        } catch (err) { next(err); }
    }

    static async clear_current_pid(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id } = clear_current_pid_schema.parse(req.body);
            await RunService.clear_current_pid(run_id);
            res.json({ ok: true });
        } catch (err) { next(err); }
    }

    static async crash_stale(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const parsed = crash_stale_schema.parse(req.body);
            const count = await RunService.crash_stale(parsed?.daemon_id);
            res.json({ ok: true, count });
        } catch (err) { next(err); }
    }

    static async delete_by_workspace(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { workspace_id } = delete_by_workspace_schema.parse(req.body);
            const count = await RunService.delete_by_workspace(workspace_id);
            res.json({ ok: true, count });
        } catch (err) { next(err); }
    }


    // --- Events ---

    static async events_append(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id, type, phase, agent, payload } = events_append_schema.parse(req.body);
            const id = await RunService.append_event(run_id, type, phase, agent, payload);
            res.json({ ok: true, id });
        } catch (err) { next(err); }
    }

    static async events_get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id, after } = events_get_schema.parse(req.body);
            if (after !== undefined) {
                const events = await RunService.list_events_after(run_id, after);
                res.json({ ok: true, events });
                return;
            }
            const events = await RunService.list_events(run_id);
            res.json({ ok: true, events });
        } catch (err) { next(err); }
    }

    static async events_count(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id } = events_count_schema.parse(req.body);
            const count = await RunService.count_events(run_id);
            res.json({ ok: true, count });
        } catch (err) { next(err); }
    }

    static async events_delete(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id } = events_delete_schema.parse(req.body);
            const count = await RunService.delete_events(run_id);
            res.json({ ok: true, count });
        } catch (err) { next(err); }
    }

    // --- Run status (phase runtime) ---

    static async get_status(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id, status } = get_status_schema.parse(req.body);
            if (status) {
                const phases = await RunService.list_phases_by_status(run_id, status);
                res.json({ ok: true, phases });
                return;
            }
            const phases = await RunService.list_phases(run_id);
            res.json({ ok: true, phases });
        } catch (err) { next(err); }
    }

    static async update_status(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id, phases } = update_status_schema.parse(req.body);
            await RunService.update_phases_status(run_id, phases);
            res.json({ ok: true });
        } catch (err) { next(err); }
    }

    // --- Artifacts ---

    static async artifacts_create(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = artifacts_create_schema.parse(req.body);
            const id = await RunService.create_artifact(data);
            res.json({ ok: true, id });
        } catch (err) { next(err); }
    }

    static async artifacts_append_handoff(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id, from_phase, to_phase, name, content } = artifacts_append_handoff_schema.parse(req.body);
            const id = await RunService.append_handoff(run_id, from_phase, to_phase, name, content);
            res.json({ ok: true, id });
        } catch (err) { next(err); }
    }

    static async artifacts_get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id, phase, kind, target_phase } = artifacts_get_schema.parse(req.body);
            if (target_phase) {
                const artifacts = await RunService.list_handoffs_for(run_id, target_phase);
                res.json({ ok: true, artifacts });
                return;
            }
            if (phase) {
                const artifacts = await RunService.list_artifacts_by_phase(run_id, phase);
                res.json({ ok: true, artifacts });
                return;
            }
            if (kind) {
                const artifacts = await RunService.list_artifacts_by_kind(run_id, kind);
                res.json({ ok: true, artifacts });
                return;
            }
            const artifacts = await RunService.list_artifacts(run_id);
            res.json({ ok: true, artifacts });
        } catch (err) { next(err); }
    }

    static async artifacts_delete(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { run_id } = artifacts_delete_schema.parse(req.body);
            const count = await RunService.delete_artifacts(run_id);
            res.json({ ok: true, count });
        } catch (err) { next(err); }
    }
}
