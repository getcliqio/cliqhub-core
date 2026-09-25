/**
 * Runs Hub resource — RUN-ORG invent + RUN-S0 MVC structure.
 *
 * POST /v1/runs/get org-scoped recent list: body `org_id` required.
 * Never invent org from X-Org-Id / current_org_id.
 * Keyed scopes (realm_id | daemon_id | workspace_id | parent_run_id) need no org_id.
 * Envelope stays flat until a future RUN-ENV slice.
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
import type { FlatApiOkResponse, FlatApiRequest } from '../types/api_response.js';
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

type RunsFields = Record<string, unknown>;

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

    // --- Core run methods ---

    /**
     * Org-scoped recent list requires body `org_id` (RUN-ORG hard-cut).
     * Never invent from X-Org-Id / current_org_id.
     * Keyed scopes (realm_id | daemon_id | workspace_id | parent_run_id) omit org_id.
     */
    async get(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            // Zod SoT — org-scoped list requires org_id; never invent from X-Org-Id.
            const filters = this.parse_body(RunsGetInput, req);
            if (filters.parent_run_id) {
                const runs = await RunService.list_children(filters.parent_run_id);
                res.json({ ok: true, runs });
                return;
            }
            if (filters.active_only && filters.workspace_id) {
                const runs = await RunService.list_active(filters.workspace_id);
                res.json({ ok: true, runs });
                return;
            }
            if (filters.workspace_id) {
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
            // Org-scoped recent list: body.org_id is invent SoT (Zod already required it).
            // realm_id / daemon_id paths may omit org_id — do not invent from header.
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
            res.json({
                ok: true,
                runs: result.runs,
                total: result.total,
                offset: filters?.offset ?? 0,
                limit: filters?.limit ?? 20,
            });
    }

    async get_by_id(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id } = this.parse_body(RunsGetByIdInput, req);
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
    }

    async get_by_name(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_name } = this.parse_body(RunsGetByNameInput, req);
            const run = await RunService.get_by_name(run_name);
            res.json({ ok: true, run });
    }

    async resolve(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { id_or_name } = this.parse_body(RunsResolveInput, req);
            const run = await RunService.resolve(id_or_name);
            res.json({ ok: true, run });
    }

    async create(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const data = this.parse_body(RunsCreateInput, req);
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
    }

    async complete(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id, state, error } = this.parse_body(RunsCompleteInput, req);
            await RunService.complete(run_id, state, error);
            res.json({ ok: true });
    }

    /**
     * POST /v1/runs/resume
     * - Daemon mirror: `{ run_id }` → Hub state awaiting_input → running
     * - User control: `{ run_id, from_phase }` → outbox resume to daemon
     */
    async resume(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id, from_phase } = this.parse_body(RunsResumeInput, req);
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
    }

    async cancel(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id, reason } = this.parse_body(RunsCancelInput, req);
            const result = await DispatchService.cancel_run(
                run_id,
                req.user?.org_ids ?? [],
                req.user?.user_id,
                reason,
            );
            res.json({ ok: true, ...result });
    }

    async supply_inputs(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const data = this.parse_body(RunsSupplyInputsInput, req);
            const result = await DispatchService.supply_inputs({
                run_id: data.run_id,
                inputs: data.inputs,
                user_id: req.user?.user_id ?? '',
            });
            res.json({ ok: true, ...result });
    }

    /**
     * POST /v1/runs/enqueue — schedule a run (Slice 2).
     * - realm_id → exclusive offer/claim (former dispatch/enqueue kind=run)
     * - daemon_id → pinned execute (former dispatch/run)
     */
    async enqueue(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const data = this.parse_body(RunsEnqueueInput, req);
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
    }

    /** POST /v1/runs/claim — daemon (or member) claims an exclusive queue item. */
    async claim(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const data = this.parse_body(RunsClaimInput, req);
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
    }

    /** POST /v1/runs/queue/get_by_id — ops/debug status for one queue row. */
    async queue_get_by_id(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { queue_item_id } = this.parse_body(RunsQueueGetByIdInput, req);
            const user_id = req.user?.user_id ?? '';
            if (!user_id) throw ApiError.forbidden('Not authenticated');

            const item = await QueueService.get(queue_item_id);
            await RealmService.assert_member(item.realm_id, user_id);
            res.json({ ok: true, item });
    }

    async restart(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id } = this.parse_body(RunsRestartInput, req);
            await RunService.restart(run_id);
            res.json({ ok: true });
    }

    async set_current_pid(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id, pid, phase } = this.parse_body(RunsSetCurrentPidInput, req);
            await RunService.set_current_pid(run_id, pid, phase);
            res.json({ ok: true });
    }

    async clear_current_pid(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id } = this.parse_body(RunsClearCurrentPidInput, req);
            await RunService.clear_current_pid(run_id);
            res.json({ ok: true });
    }

    async crash_stale(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            if (req.body == null || typeof req.body !== 'object') {
                (req as Request & { body: Record<string, unknown> }).body = {};
            }
            const parsed = this.parse_body(RunsCrashStaleInput, req);
            const count = await RunService.crash_stale(parsed.daemon_id);
            res.json({ ok: true, count });
    }

    async delete_by_workspace(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { workspace_id } = this.parse_body(RunsDeleteByWorkspaceInput, req);
            const count = await RunService.delete_by_workspace(workspace_id);
            res.json({ ok: true, count });
    }


    // --- Events ---

    async events_append(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id, type, phase, agent, payload } = this.parse_body(RunsEventsAppendInput, req);
            const id = await RunService.append_event(run_id, type, phase, agent, payload);
            res.json({ ok: true, id });
    }

    async events_get(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id, after } = this.parse_body(RunsEventsGetInput, req);
            if (after !== undefined) {
                const events = await RunService.list_events_after(run_id, after);
                res.json({ ok: true, events });
                return;
            }
            const events = await RunService.list_events(run_id);
            res.json({ ok: true, events });
    }

    async events_count(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id } = this.parse_body(RunsEventsCountInput, req);
            const count = await RunService.count_events(run_id);
            res.json({ ok: true, count });
    }

    async events_delete(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id } = this.parse_body(RunsEventsDeleteInput, req);
            const count = await RunService.delete_events(run_id);
            res.json({ ok: true, count });
    }

    // --- Run status (phase runtime) ---

    async get_status(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id, status } = this.parse_body(RunsGetStatusInput, req);
            if (status) {
                const phases = await RunService.list_phases_by_status(run_id, status);
                res.json({ ok: true, phases });
                return;
            }
            const phases = await RunService.list_phases(run_id);
            res.json({ ok: true, phases });
    }

    async update_status(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id, phases } = this.parse_body(RunsUpdateStatusInput, req);
            await RunService.update_phases_status(run_id, phases);
            res.json({ ok: true });
    }

    // --- Artifacts ---

    async artifacts_create(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const data = this.parse_body(RunsArtifactsCreateInput, req);
            const id = await RunService.create_artifact(data);
            res.json({ ok: true, id });
    }

    async artifacts_append_handoff(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id, from_phase, to_phase, name, content } = this.parse_body(RunsArtifactsAppendHandoffInput, req);
            const id = await RunService.append_handoff(run_id, from_phase, to_phase, name, content);
            res.json({ ok: true, id });
    }

    async artifacts_get(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id, phase, kind, target_phase } = this.parse_body(RunsArtifactsGetInput, req);
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
    }

    async artifacts_delete(req: FlatApiRequest<Record<string, unknown>, RunsFields>, res: FlatApiOkResponse<RunsFields>): Promise<void> {
            const { run_id } = this.parse_body(RunsArtifactsDeleteInput, req);
            const count = await RunService.delete_artifacts(run_id);
            res.json({ ok: true, count });
    }
}
