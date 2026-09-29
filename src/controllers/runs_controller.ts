/**
 * Runs Hub resource — RUN-ORG invent + RUN-ENV `{ ok, data }` envelope.
 *
 * POST /v1/runs/get org-scoped recent list: body `org_id` required.
 * Never invent org from X-Org-Id / current_org_id.
 * Keyed scopes (realm_id | daemon_id | workspace_id | parent_run_id) need no org_id.
 *
 * Envelope: `{ ok: true, data: T }` via BaseController.ok (RUN-ENV).
 */

import { BaseController } from './base_controller.js';
import { RunService } from '../services/run.service.js';
import { DispatchService } from '../services/dispatch.service.js';
import { QueueService } from '../services/queue.service.js';
import { RealmService } from '../services/realm.service.js';
import { ApiError } from '../lib/api_error.js';
import type { ApiOkResponse, ApiRequest, BooleanData, PagedData } from '../types/api_response.js';
import { to_run_data } from '../types/mappers.js';
import {
    RunsArtifactsCreateInput,
    RunsCancelInput,
    RunsClaimInput,
    RunsCompleteInput,
    RunsCreateInput,
    RunsEnqueueInput,
    RunsGetByIdInput,
    RunsGetInput,
    RunsGetStatusInput,
    RunsResumeInput,
    RunsSupplyInputsInput,
    RunsUpdateStatusInput,
} from '../schemas/run_types.js';
import type {
    QueueItemData,
    RunCancelData,
    RunCreateData,
    RunData,
    RunDispatchData,
    RunEnqueueData,
    RunIdData,
    RunPhaseData,
    RunResumeData,
    RunSupplyInputsData,
} from '../schemas/run_types.js';

export class RunController extends BaseController {
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

    /**
     * POST /v1/runs/get — list runs (paged).
     *
     * All scopes (keyed: parent_run_id / workspace_id / daemon_id / realm_id;
     * or org-scoped recent list) route through `RunService.list_recent` with
     * dynamic Sequelize WHERE. Keyed scopes skip the realm gate.
     * Org-scoped recent list requires body `org_id` (RUN-ORG hard-cut).
     */
    async get(
        req: ApiRequest<RunsGetInput, PagedData<RunData>>,
        res: ApiOkResponse<PagedData<RunData>>,
    ): Promise<void> {
        const filters = this.parse_body(RunsGetInput, req);

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
                parent_run_id: filters.parent_run_id,
                workspace_id: filters.workspace_id,
                active_only: filters.active_only,
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

    /** POST /v1/runs/get_by_id — one run with detail enrichment. */
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

    /** POST /v1/runs/create — daemon outbox create ack. */
    async create(
        req: ApiRequest<RunsCreateInput, RunCreateData>,
        res: ApiOkResponse<RunCreateData>,
    ): Promise<void> {
        const body = this.parse_body(RunsCreateInput, req);
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

    /** POST /v1/runs/complete */
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

    /** POST /v1/runs/cancel */
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

    /** POST /v1/runs/supply_inputs */
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

    /** POST /v1/runs/claim — daemon (or member) claims an exclusive queue item. */
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

    /** POST /v1/runs/get_status */
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

    /** POST /v1/runs/update_status */
    async update_status(
        req: ApiRequest<RunsUpdateStatusInput, BooleanData>,
        res: ApiOkResponse<BooleanData>,
    ): Promise<void> {
        const { run_id, phases } = this.parse_body(RunsUpdateStatusInput, req);
        await RunService.update_phases_status(run_id, phases);
        this.ok(res, true);
    }

    /** POST /v1/runs/artifacts/create */
    async artifacts_create(
        req: ApiRequest<RunsArtifactsCreateInput, RunIdData>,
        res: ApiOkResponse<RunIdData>,
    ): Promise<void> {
        const body = this.parse_body(RunsArtifactsCreateInput, req);
        const id = await RunService.create_artifact(body);
        const data: RunIdData = { id };
        this.ok(res, data);
    }
}
