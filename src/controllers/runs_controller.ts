/**
 * Runs Hub resource — RUN-ORG invent + RUN-ENV `{ ok, data }` envelope.
 *
 * POST /v1/runs/get org-scoped recent list: body `org_id` required.
 * Never invent org from X-Org-Id / current_org_id.
 * Keyed scopes (realm_id | daemon_id | workspace_id | parent_run_id) need no org_id.
 *
 * Envelope: `{ ok: true, data: T }` via BaseController.ok (RUN-ENV).
 */

import type { Request } from 'express';
import { BaseController } from './base_controller.js';
import { RunService } from '../services/run.service.js';
import { DispatchService } from '../services/dispatch.service.js';
import { QueueService } from '../services/queue.service.js';
import { RealmService } from '../services/realm.service.js';
import { Realm } from '../models/index.js';
import { ApiError } from '../lib/api_error.js';
import type { AuthContext } from '../types/vo.js';
import type { ApiOkResponse, ApiRequest, BooleanData, PagedData } from '../types/api_response.js';
import { to_run_data } from '../types/mappers.js';
import {
    RunsArtifactsAppendHandoffInput,
    RunsArtifactsCreateInput,
    RunsArtifactsDeleteInput,
    RunsArtifactsGetInput,
    RunsCancelInput,
    RunsClaimInput,
    RunsClearCurrentPidInput,
    RunsCompleteInput,
    RunsCrashStaleInput,
    RunsCreateInput,
    RunsDeleteByWorkspaceInput,
    RunsEnqueueInput,
    RunsEventsAppendInput,
    RunsEventsCountInput,
    RunsEventsDeleteInput,
    RunsEventsGetInput,
    RunsGetByIdInput,
    RunsGetByNameInput,
    RunsGetInput,
    RunsGetStatusInput,
    RunsQueueGetByIdInput,
    RunsResolveInput,
    RunsRestartInput,
    RunsResumeInput,
    RunsSetCurrentPidInput,
    RunsSupplyInputsInput,
    RunsUpdateStatusInput,
} from '../schemas/runs/inputs.js';
import type {
    QueueItemData,
    RunArtifactData,
    RunCancelData,
    RunCountData,
    RunCreateData,
    RunData,
    RunDispatchData,
    RunEnqueueData,
    RunEventData,
    RunIdData,
    RunPhaseData,
    RunResumeData,
    RunSupplyInputsData,
} from '../schemas/runs/data.js';

export class RunController extends BaseController {
    /**
     * Bearer must be allowed to act on `org_id`.
     * PAT/session: org_id ∈ auth.org_ids. Daemon token: realm.org_id === org_id.
     * Site hub admin may act on any org_id.
     */
    private async assert_org_authorized(auth: AuthContext | undefined, org_id: string): Promise<void> {
        // No credential context — refuse rather than invent tenancy.
        if (!auth) {
            throw ApiError.unauthorized('authentication required');
        }

        // Site admin may target any org.
        if (auth.user?.role === 'admin') return;

        // Daemon tokens are realm-bound; tenancy is the realm's org.
        if (auth.auth_via === 'daemon_token') {
            if (!auth.realm_id) {
                throw ApiError.forbidden('daemon token has no realm binding');
            }
            const realm = await Realm.findByPk(auth.realm_id);
            if (!realm || realm.org_id !== org_id) {
                throw ApiError.forbidden('org_id does not match daemon realm organization');
            }
            return;
        }

        // PAT / session: live membership list from auth middleware.
        if (!auth.org_ids.includes(org_id)) {
            throw ApiError.forbidden('not a member of the requested organization');
        }
    }

    private auth_from(req: Request): AuthContext | undefined {
        return req.auth;
    }

    /** Map enriched / Sequelize run rows to wire RunData[]. */
    private map_runs(rows: unknown[]): RunData[] {
        return rows.map((r) => to_run_data(r as Parameters<typeof to_run_data>[0]));
    }

    private map_phases(rows: unknown[]): RunPhaseData[] {
        return rows.map((row) => {
            const plain = typeof (row as { toJSON?: () => unknown }).toJSON === 'function'
                ? (row as { toJSON: () => Record<string, unknown> }).toJSON()
                : (row as Record<string, unknown>);
            const data: RunPhaseData = {
                run_id: plain.run_id == null ? undefined : String(plain.run_id),
                phase: String(plain.phase ?? ''),
                status: String(plain.status ?? ''),
                sequence: plain.sequence == null ? undefined : Number(plain.sequence),
                started_at: plain.started_at == null ? null : Number(plain.started_at),
                completed_at: plain.completed_at == null ? null : Number(plain.completed_at),
                error: plain.error == null ? null : String(plain.error),
                agent: plain.agent == null ? null : String(plain.agent),
            };
            return data;
        });
    }

    private map_events(rows: unknown[]): RunEventData[] {
        return rows.map((row) => {
            const plain = typeof (row as { toJSON?: () => unknown }).toJSON === 'function'
                ? (row as { toJSON: () => Record<string, unknown> }).toJSON()
                : (row as Record<string, unknown>);
            const data: RunEventData = {
                id: String(plain.id ?? ''),
                run_id: plain.run_id == null ? undefined : String(plain.run_id),
                type: plain.type == null ? undefined : String(plain.type),
                event_type: plain.event_type == null ? undefined : String(plain.event_type),
                phase: plain.phase == null ? null : String(plain.phase),
                agent: plain.agent == null ? null : String(plain.agent),
                payload: plain.payload ?? null,
                created_at: plain.created_at == null ? undefined : Number(plain.created_at),
                timestamp: plain.timestamp == null ? undefined : Number(plain.timestamp),
            };
            return data;
        });
    }

    private map_artifacts(rows: unknown[]): RunArtifactData[] {
        return rows.map((row) => {
            const plain = typeof (row as { toJSON?: () => unknown }).toJSON === 'function'
                ? (row as { toJSON: () => Record<string, unknown> }).toJSON()
                : (row as Record<string, unknown>);
            const data: RunArtifactData = {
                id: String(plain.id ?? ''),
                run_id: plain.run_id == null ? undefined : String(plain.run_id),
                phase: plain.phase == null ? null : String(plain.phase),
                kind: plain.kind == null ? undefined : String(plain.kind),
                name: plain.name == null ? undefined : String(plain.name),
                content: plain.content,
                target_phase: plain.target_phase == null ? null : String(plain.target_phase),
                sequence: plain.sequence == null ? undefined : Number(plain.sequence),
            };
            return data;
        });
    }

    // --- Core run methods ---

    /**
     * POST /v1/runs/get — list runs (paged or keyed scopes).
     *
     * Org-scoped recent list requires body `org_id` (RUN-ORG hard-cut).
     * Never invent from X-Org-Id / current_org_id.
     * Keyed scopes (realm_id | daemon_id | workspace_id | parent_run_id) omit org_id.
     *
     * @param req - Body: {@link RunsGetInput}
     * @param res - `{ ok: true, data: RunData[] | PagedData<RunData> }`
     */
    async get(
        req: ApiRequest<RunsGetInput, RunData[] | PagedData<RunData>>,
        res: ApiOkResponse<RunData[] | PagedData<RunData>>,
    ): Promise<void> {
        // Zod SoT — org-scoped list requires org_id; never invent from X-Org-Id.
        const filters = this.parse_body(RunsGetInput, req);

        if (filters.parent_run_id) {
            const rows = await RunService.list_children(filters.parent_run_id);
            const data: RunData[] = this.map_runs(rows);
            this.ok(res, data);
            return;
        }

        if (filters.active_only && filters.workspace_id) {
            const rows = await RunService.list_active(filters.workspace_id);
            const data: RunData[] = this.map_runs(rows);
            this.ok(res, data);
            return;
        }

        if (filters.workspace_id) {
            const result = await RunService.list_by_workspace(
                filters.workspace_id,
                filters.limit,
                filters.offset,
            );
            const data: PagedData<RunData> = {
                items: this.map_runs(result.runs),
                total: result.total,
                offset: filters.offset ?? 0,
                limit: filters.limit ?? 50,
            };
            this.ok(res, data);
            return;
        }

        // Org-scoped recent list: body.org_id is invent SoT when present.
        let org_id: string | undefined;
        if (filters.org_id) {
            await this.assert_org_authorized(this.auth_from(req), filters.org_id);
            org_id = filters.org_id;
        }

        const result = await RunService.list_recent(
            filters.limit,
            filters.daemon_id,
            {
                query: filters.query,
                state: filters.state,
                realm_id: filters.realm_id,
                offset: filters.offset,
                since_ms: filters.since_ms,
                until_ms: filters.until_ms,
                user_id: req.user?.user_id,
                org_id,
                sort_by: filters.sort_by,
                sort_dir: filters.sort_dir,
            },
        );

        const data: PagedData<RunData> = {
            items: this.map_runs(result.runs),
            total: result.total,
            offset: filters.offset ?? 0,
            limit: filters.limit ?? 20,
        };
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/get_by_id — one run with detail enrichment.
     *
     * @param req - Body: {@link RunsGetByIdInput}
     * @param res - `{ ok: true, data: RunData | null }`
     */
    async get_by_id(
        req: ApiRequest<RunsGetByIdInput, RunData | null>,
        res: ApiOkResponse<RunData | null>,
    ): Promise<void> {
        const { run_id } = this.parse_body(RunsGetByIdInput, req);
        const run = await RunService.get(run_id);
        if (!run) {
            this.ok(res, null);
            return;
        }

        // Enrich for the detail banner (pending control / force-terminate / orphan).
        const daemon_id = (run.get('daemon_id') as string | null) ?? null;
        const [pending_control, force_status, state_lost_at, team_version_id] = await Promise.all([
            RunService.load_pending_control(daemon_id, run_id),
            RunService.load_force_terminate_status(run_id, daemon_id),
            RunService.load_state_lost_at(run_id),
            RunService.load_team_version_id(run_id),
        ]);

        const data: RunData = to_run_data(run, {
            pending_control: pending_control,
            force_terminate: force_status,
            state_lost_at,
            team_version_id,
        });
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/get_by_name
     * @param res - `{ ok: true, data: RunData | null }`
     */
    async get_by_name(
        req: ApiRequest<RunsGetByNameInput, RunData | null>,
        res: ApiOkResponse<RunData | null>,
    ): Promise<void> {
        const { run_name } = this.parse_body(RunsGetByNameInput, req);
        const run = await RunService.get_by_name(run_name);
        if (!run) {
            this.ok(res, null);
            return;
        }
        const data: RunData = to_run_data(run);
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/resolve — id or name lookup.
     * @param res - `{ ok: true, data: RunData | null }`
     */
    async resolve(
        req: ApiRequest<RunsResolveInput, RunData | null>,
        res: ApiOkResponse<RunData | null>,
    ): Promise<void> {
        const { id_or_name } = this.parse_body(RunsResolveInput, req);
        const run = await RunService.resolve(id_or_name);
        if (!run) {
            this.ok(res, null);
            return;
        }
        const data: RunData = to_run_data(run);
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/create — daemon outbox create ack.
     * @param res - `{ ok: true, data: RunCreateData }`
     */
    async create(
        req: ApiRequest<RunsCreateInput, RunCreateData>,
        res: ApiOkResponse<RunCreateData>,
    ): Promise<void> {
        const body = this.parse_body(RunsCreateInput, req);
        // Pass parsed create arm through — field names match the service.
        const run_id = await RunService.create(body.workspace_id, body.team_id, {
            run_id: body.run_id,
            daemon_id: body.daemon_id,
            workspace_path: body.workspace_path,
            workspace_name: body.workspace_name,
            run_name: body.run_name,
            parent_run_id: body.parent_run_id,
            parent_phase: body.parent_phase,
            inputs: body.inputs,
            external_id: body.external_id,
            context_labels: body.context_labels,
            execution_type: body.execution_type,
        });
        const data: RunCreateData = { run_id };
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/complete
     * @param res - `{ ok: true, data: BooleanData }`
     */
    async complete(
        req: ApiRequest<RunsCompleteInput, BooleanData>,
        res: ApiOkResponse<BooleanData>,
    ): Promise<void> {
        const { run_id, state, error } = this.parse_body(RunsCompleteInput, req);
        await RunService.complete(run_id, state, error);
        this.ok(res, true);
    }

    /**
     * POST /v1/runs/resume
     * - Daemon mirror: `{ run_id }` → Hub state awaiting_input → running
     * - User control: `{ run_id, from_phase }` → outbox resume to daemon
     *
     * @param res - `{ ok: true, data: BooleanData | RunResumeData }`
     */
    async resume(
        req: ApiRequest<RunsResumeInput, BooleanData | RunResumeData>,
        res: ApiOkResponse<BooleanData | RunResumeData>,
    ): Promise<void> {
        const { run_id, from_phase } = this.parse_body(RunsResumeInput, req);
        if (from_phase) {
            const result = await DispatchService.resume(
                run_id,
                from_phase,
                req.user?.org_ids ?? [],
                req.user?.user_id,
            );
            const data: RunResumeData = {
                resumed: result.resumed,
                from_phase: result.from_phase,
            };
            this.ok(res, data);
            return;
        }
        await RunService.resume(run_id);
        this.ok(res, true);
    }

    /**
     * POST /v1/runs/cancel
     * @param res - `{ ok: true, data: RunCancelData }`
     */
    async cancel(
        req: ApiRequest<RunsCancelInput, RunCancelData>,
        res: ApiOkResponse<RunCancelData>,
    ): Promise<void> {
        const { run_id, reason } = this.parse_body(RunsCancelInput, req);
        const result = await DispatchService.cancel_run(
            run_id,
            req.user?.org_ids ?? [],
            req.user?.user_id,
            reason,
        );
        const data: RunCancelData = {
            cancelled: result.cancelled,
            mode: result.mode,
        };
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/supply_inputs
     * @param res - `{ ok: true, data: RunSupplyInputsData }`
     */
    async supply_inputs(
        req: ApiRequest<RunsSupplyInputsInput, RunSupplyInputsData>,
        res: ApiOkResponse<RunSupplyInputsData>,
    ): Promise<void> {
        const body = this.parse_body(RunsSupplyInputsInput, req);
        const result = await DispatchService.supply_inputs({
            run_id: body.run_id,
            inputs: body.inputs,
            user_id: req.user?.user_id ?? '',
        });
        const data: RunSupplyInputsData = {
            supplied: result.supplied,
            run_id: result.run_id,
        };
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/enqueue — schedule a run (Slice 2).
     * - realm_id → exclusive offer/claim
     * - daemon_id → pinned execute
     *
     * @param res - `{ ok: true, data: RunDispatchData | RunEnqueueData }`
     */
    async enqueue(
        req: ApiRequest<RunsEnqueueInput, RunDispatchData | RunEnqueueData>,
        res: ApiOkResponse<RunDispatchData | RunEnqueueData>,
    ): Promise<void> {
        const body = this.parse_body(RunsEnqueueInput, req);
        const user_id = req.user?.user_id ?? '';
        const org_ids = req.user?.org_ids ?? [];
        const scope_ids = req.user?.scope_ids ?? [];

        if (body.daemon_id) {
            const run_context = {
                ...(body.run_context ?? {}),
                inputs: {
                    ...(body.run_context?.inputs ?? {}),
                    ...(body.inputs ?? {}),
                },
            };
            const result = await DispatchService.dispatch_run({
                workspace_id: body.workspace_id!,
                team_id: body.team_id!,
                daemon_id: body.daemon_id,
                realm_id: body.realm_id,
                workspace_path: body.workspace_path,
                manifest_yaml: body.manifest_yaml,
                run_context,
                run_name: body.run_name,
                execution_type: body.execution_type,
                org_ids,
                user_id,
                scope_ids,
            });
            const data: RunDispatchData = {
                run_id: result.run_id,
                daemon_id: result.daemon_id,
                accepted: result.accepted,
            };
            this.ok(res, data);
            return;
        }

        const payload: Record<string, unknown> = { ...(body.payload ?? {}) };
        if (body.team_id) payload.team_id = body.team_id;
        if (body.workspace_id) payload.workspace_id = body.workspace_id;
        if (body.workspace_path) payload.workspace_path = body.workspace_path;
        if (body.manifest_yaml) payload.manifest_yaml = body.manifest_yaml;
        if (body.run_name) payload.run_name = body.run_name;
        if (body.execution_type) payload.execution_type = body.execution_type;
        const inputs = {
            ...((payload.inputs && typeof payload.inputs === 'object' && !Array.isArray(payload.inputs))
                ? payload.inputs as Record<string, unknown>
                : {}),
            ...(body.inputs ?? {}),
            ...(body.run_context?.inputs ?? {}),
        };
        if (Object.keys(inputs).length > 0) payload.inputs = inputs;
        if (body.run_context) {
            payload.run_context = {
                ...body.run_context,
                inputs: {
                    ...(body.run_context.inputs ?? {}),
                    ...inputs,
                },
            };
        }

        const result = await DispatchService.enqueue({
            realm_id: body.realm_id!,
            kind: 'run',
            payload,
            priority: body.priority,
            user_id,
            scope_ids,
            org_ids,
        });
        const data: RunEnqueueData = { item: result.item as QueueItemData };
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/claim — daemon (or member) claims an exclusive queue item.
     * @param res - `{ ok: true, data: QueueItemData }`
     */
    async claim(
        req: ApiRequest<RunsClaimInput, QueueItemData>,
        res: ApiOkResponse<QueueItemData>,
    ): Promise<void> {
        const body = this.parse_body(RunsClaimInput, req);
        const item = await QueueService.get(body.queue_item_id);

        if (req.auth?.auth_via === 'daemon_token') {
            const realm_id = req.auth.realm_id;
            if (!realm_id) throw ApiError.forbidden('Daemon token has no primary realm');
            if (realm_id !== item.realm_id) {
                throw ApiError.forbidden('Daemon token realm does not match queue item');
            }
            await RealmService.assert_daemon_in_realm(item.realm_id, body.daemon_id);
        }
        if (req.auth?.auth_via !== 'daemon_token') {
            const user_id = req.user?.user_id ?? '';
            if (!user_id) throw ApiError.forbidden('Not authenticated');
            await RealmService.assert_member(item.realm_id, user_id);
        }

        const claimed = await QueueService.claim(body.queue_item_id, body.daemon_id);
        const data: QueueItemData = claimed as QueueItemData;
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/queue/get_by_id
     * @param res - `{ ok: true, data: QueueItemData }`
     */
    async queue_get_by_id(
        req: ApiRequest<RunsQueueGetByIdInput, QueueItemData>,
        res: ApiOkResponse<QueueItemData>,
    ): Promise<void> {
        const { queue_item_id } = this.parse_body(RunsQueueGetByIdInput, req);
        const user_id = req.user?.user_id ?? '';
        if (!user_id) throw ApiError.forbidden('Not authenticated');

        const item = await QueueService.get(queue_item_id);
        await RealmService.assert_member(item.realm_id, user_id);
        const data: QueueItemData = item as QueueItemData;
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/restart
     * @param res - `{ ok: true, data: BooleanData }`
     */
    async restart(
        req: ApiRequest<RunsRestartInput, BooleanData>,
        res: ApiOkResponse<BooleanData>,
    ): Promise<void> {
        const { run_id } = this.parse_body(RunsRestartInput, req);
        await RunService.restart(run_id);
        this.ok(res, true);
    }

    /**
     * POST /v1/runs/set_current_pid
     * @param res - `{ ok: true, data: BooleanData }`
     */
    async set_current_pid(
        req: ApiRequest<RunsSetCurrentPidInput, BooleanData>,
        res: ApiOkResponse<BooleanData>,
    ): Promise<void> {
        const { run_id, pid, phase } = this.parse_body(RunsSetCurrentPidInput, req);
        await RunService.set_current_pid(run_id, pid, phase);
        this.ok(res, true);
    }

    /**
     * POST /v1/runs/clear_current_pid
     * @param res - `{ ok: true, data: BooleanData }`
     */
    async clear_current_pid(
        req: ApiRequest<RunsClearCurrentPidInput, BooleanData>,
        res: ApiOkResponse<BooleanData>,
    ): Promise<void> {
        const { run_id } = this.parse_body(RunsClearCurrentPidInput, req);
        await RunService.clear_current_pid(run_id);
        this.ok(res, true);
    }

    /**
     * POST /v1/runs/crash_stale
     * @param res - `{ ok: true, data: RunCountData }`
     */
    async crash_stale(
        req: ApiRequest<RunsCrashStaleInput, RunCountData>,
        res: ApiOkResponse<RunCountData>,
    ): Promise<void> {
        if (req.body == null || typeof req.body !== 'object') {
            (req as Request & { body: Record<string, unknown> }).body = {};
        }
        const parsed = this.parse_body(RunsCrashStaleInput, req);
        const count = await RunService.crash_stale(parsed.daemon_id);
        const data: RunCountData = { count };
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/delete_by_workspace
     * @param res - `{ ok: true, data: RunCountData }`
     */
    async delete_by_workspace(
        req: ApiRequest<RunsDeleteByWorkspaceInput, RunCountData>,
        res: ApiOkResponse<RunCountData>,
    ): Promise<void> {
        const { workspace_id } = this.parse_body(RunsDeleteByWorkspaceInput, req);
        const count = await RunService.delete_by_workspace(workspace_id);
        const data: RunCountData = { count };
        this.ok(res, data);
    }

    // --- Events ---

    /**
     * POST /v1/runs/events/append
     * @param res - `{ ok: true, data: RunIdData }`
     */
    async events_append(
        req: ApiRequest<RunsEventsAppendInput, RunIdData>,
        res: ApiOkResponse<RunIdData>,
    ): Promise<void> {
        const { run_id, type, phase, agent, payload } = this.parse_body(RunsEventsAppendInput, req);
        const id = await RunService.append_event(run_id, type, phase, agent, payload);
        const data: RunIdData = { id };
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/events/get
     * @param res - `{ ok: true, data: RunEventData[] }`
     */
    async events_get(
        req: ApiRequest<RunsEventsGetInput, RunEventData[]>,
        res: ApiOkResponse<RunEventData[]>,
    ): Promise<void> {
        const { run_id, after } = this.parse_body(RunsEventsGetInput, req);
        if (after !== undefined) {
            const rows = await RunService.list_events_after(run_id, after);
            this.ok(res, this.map_events(rows));
            return;
        }
        const rows = await RunService.list_events(run_id);
        this.ok(res, this.map_events(rows));
    }

    /**
     * POST /v1/runs/events/count
     * @param res - `{ ok: true, data: RunCountData }`
     */
    async events_count(
        req: ApiRequest<RunsEventsCountInput, RunCountData>,
        res: ApiOkResponse<RunCountData>,
    ): Promise<void> {
        const { run_id } = this.parse_body(RunsEventsCountInput, req);
        const count = await RunService.count_events(run_id);
        const data: RunCountData = { count };
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/events/delete
     * @param res - `{ ok: true, data: RunCountData }`
     */
    async events_delete(
        req: ApiRequest<RunsEventsDeleteInput, RunCountData>,
        res: ApiOkResponse<RunCountData>,
    ): Promise<void> {
        const { run_id } = this.parse_body(RunsEventsDeleteInput, req);
        const count = await RunService.delete_events(run_id);
        const data: RunCountData = { count };
        this.ok(res, data);
    }

    // --- Run status (phase runtime) ---

    /**
     * POST /v1/runs/get_status
     * @param res - `{ ok: true, data: RunPhaseData[] }`
     */
    async get_status(
        req: ApiRequest<RunsGetStatusInput, RunPhaseData[]>,
        res: ApiOkResponse<RunPhaseData[]>,
    ): Promise<void> {
        const { run_id, status } = this.parse_body(RunsGetStatusInput, req);
        if (status) {
            const rows = await RunService.list_phases_by_status(run_id, status);
            this.ok(res, this.map_phases(rows));
            return;
        }
        const rows = await RunService.list_phases(run_id);
        this.ok(res, this.map_phases(rows));
    }

    /**
     * POST /v1/runs/update_status
     * @param res - `{ ok: true, data: BooleanData }`
     */
    async update_status(
        req: ApiRequest<RunsUpdateStatusInput, BooleanData>,
        res: ApiOkResponse<BooleanData>,
    ): Promise<void> {
        const { run_id, phases } = this.parse_body(RunsUpdateStatusInput, req);
        await RunService.update_phases_status(run_id, phases);
        this.ok(res, true);
    }

    // --- Artifacts ---

    /**
     * POST /v1/runs/artifacts/create
     * @param res - `{ ok: true, data: RunIdData }`
     */
    async artifacts_create(
        req: ApiRequest<RunsArtifactsCreateInput, RunIdData>,
        res: ApiOkResponse<RunIdData>,
    ): Promise<void> {
        const body = this.parse_body(RunsArtifactsCreateInput, req);
        const id = await RunService.create_artifact(body);
        const data: RunIdData = { id };
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/artifacts/append_handoff
     * @param res - `{ ok: true, data: RunIdData }`
     */
    async artifacts_append_handoff(
        req: ApiRequest<RunsArtifactsAppendHandoffInput, RunIdData>,
        res: ApiOkResponse<RunIdData>,
    ): Promise<void> {
        const { run_id, from_phase, to_phase, name, content } = this.parse_body(RunsArtifactsAppendHandoffInput, req);
        const id = await RunService.append_handoff(run_id, from_phase, to_phase, name, content);
        const data: RunIdData = { id };
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/artifacts/get
     * @param res - `{ ok: true, data: RunArtifactData[] }`
     */
    async artifacts_get(
        req: ApiRequest<RunsArtifactsGetInput, RunArtifactData[]>,
        res: ApiOkResponse<RunArtifactData[]>,
    ): Promise<void> {
        const { run_id, phase, kind, target_phase } = this.parse_body(RunsArtifactsGetInput, req);
        if (target_phase) {
            const rows = await RunService.list_handoffs_for(run_id, target_phase);
            this.ok(res, this.map_artifacts(rows));
            return;
        }
        if (phase) {
            const rows = await RunService.list_artifacts_by_phase(run_id, phase);
            this.ok(res, this.map_artifacts(rows));
            return;
        }
        if (kind) {
            const rows = await RunService.list_artifacts_by_kind(run_id, kind);
            this.ok(res, this.map_artifacts(rows));
            return;
        }
        const rows = await RunService.list_artifacts(run_id);
        this.ok(res, this.map_artifacts(rows));
    }

    /**
     * POST /v1/runs/artifacts/delete
     * @param res - `{ ok: true, data: RunCountData }`
     */
    async artifacts_delete(
        req: ApiRequest<RunsArtifactsDeleteInput, RunCountData>,
        res: ApiOkResponse<RunCountData>,
    ): Promise<void> {
        const { run_id } = this.parse_body(RunsArtifactsDeleteInput, req);
        const count = await RunService.delete_artifacts(run_id);
        const data: RunCountData = { count };
        this.ok(res, data);
    }
}
