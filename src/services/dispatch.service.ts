/**
 * Dispatch service — AuthZ then enqueue commands for durable delivery.
 *
 * All commands (execute, install, cancel, etc.) are enqueued via
 * `command_outbox_enqueue` for reliable, at-least-once delivery to
 * daemons. The outbox delivery worker handles transport (direct HTTP
 * or sync relay) with retry and backoff.
 *
 * Exception: `query_daemon` still uses inline HTTP POST for synchronous
 * request/response semantics (design task 4.15 — future outbox+ack).
 */

import { randomUUID } from 'node:crypto';
import { Op, QueryTypes } from 'sequelize';

import { get_sequelize } from '../lib/sequelize.js';
import { Workspace, Run, Team, Daemon, Scope, RealmMember, RealmAgentSetting, Realm } from '../models/index.js';
import { Team as HubTeam, TeamVersion } from '../db/models/index.js';
import { RunService } from './run.service.js';
import { TeamService } from './teams_install_service.js';
import { AccessService } from './access.service.js';
import { RealmService } from './realm.service.js';
import { QueueService, type Queue_item_dto } from './queue.service.js';
import { DispatchAuthService } from './dispatch_auth.service.js';
import { command_outbox_enqueue } from './command_outbox.service.js';
import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';
import { CustomEventService } from './custom_event.service.js';
import { sort_semver_desc } from '../lib/semver.js';

const log = get_logger('dispatch');

/**
 * Format a duration in ms as a short human string (`45s`, `12 min`,
 * `3 h`, `2 d`). Used in daemon-offline / stranded error messages so
 * the user sees "last seen 12 min ago" rather than raw millis.
 */
function _format_since(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return 'unknown';
    if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
    return `${Math.round(ms / 86_400_000)} d`;
}

export interface DispatchRunInput {
    workspace_id: string;
    team_id: string;
    daemon_id: string;
    workspace_path?: string;
    manifest_yaml?: string;
    run_context: {
        id?: string;
        labels?: Record<string, string>;
        inputs?: Record<string, unknown>;
    };
    run_name?: string;
    execution_type?: 'local' | 'docker';
    org_ids?: string[];
    user_id: string;
    scope_ids?: string[];
    /**
     * Realm the caller intends to run against. Snapshotted on the
     * team_runs row so the run stays visible to that realm even if the
     * daemon later joins/leaves other realms.
     */
    realm_id?: string;
    /** When set, stamped on execute payload + lifecycle logs for queue correlation. */
    queue_item_id?: string;
}

export interface DispatchResult {
    run_id: string;
    daemon_id: string;
    accepted: boolean;
}

export interface DispatchUninstallInput {
    daemon_id: string;
    scope: string;
    slug: string;
    user_id: string;
    org_ids?: string[];
}

export interface UninstallTeamInput {
    scope: string;
    slug: string;
    daemon_ids?: string[];
    realm_id?: string;
    user_id: string;
    org_ids?: string[];
}

export interface UninstallDaemonResult {
    daemon_id: string;
    ok: boolean;
    error?: string;
}

export interface UninstallTeamResult {
    scope: string;
    slug: string;
    results: UninstallDaemonResult[];
}

export interface InstallTeamInput {
    team_id: string;
    daemon_ids?: string[];
    realm_id?: string;
    user_id: string;
    scope_ids?: string[];
    org_ids?: string[];
    /** Per-agent settings to push to daemons during install. */
    agent_settings?: Record<string, Record<string, string>>;
    /** Overwrite an already-installed team with Hub's latest version. */
    force?: boolean;
    /** When set, install this specific published version instead of latest. */
    version?: string;
}

export interface InstallDaemonResult {
    daemon_id: string;
    ok: boolean;
    already_installed?: boolean;
    error?: string;
}

export interface InstallTeamResult {
    team_id: string;
    results: InstallDaemonResult[];
}

export type QueuedInstallResult = InstallTeamResult & { item: Queue_item_dto };
export type QueuedUninstallResult = UninstallTeamResult & { item: Queue_item_dto };

export class DispatchService {

    static async dispatch_run(input: DispatchRunInput): Promise<DispatchResult> {
        if (!input.user_id) {
            throw ApiError.forbidden('Not authenticated');
        }

        const daemon = await Daemon.findByPk(input.daemon_id);
        if (!daemon) {
            throw ApiError.not_found(`Daemon '${input.daemon_id}' not found`);
        }

        await AccessService.assert_can_observe_daemon(input.user_id, daemon.id);

        // Workspace/team may only exist on the daemon's local store.
        // Look up in backend DB for path/manifest if available, but don't require it.
        // Ephemeral workspaces have relative placeholder paths — send empty so
        // the daemon provisions a real directory.
        const workspace = await Workspace.findByPk(input.workspace_id);
        const stored_path = workspace?.path ?? input.workspace_path ?? '';
        const workspace_path = stored_path.startsWith('/') ? stored_path : '';

        const team = await Team.findByPk(input.team_id);
        const manifest_yaml = input.manifest_yaml ?? team?.manifest;

        if (team) {
            AccessService.assert_scope_access(input.scope_ids ?? [], team.scope_id);
        }

        // ── Validate required inputs against the registry team's declared inputs ──
        // Prevents runs from being dispatched only to stall immediately on
        // the daemon due to missing required inputs.
        await DispatchService._validate_required_inputs(
            team,
            input.run_context.inputs ?? {},
        );

        // ── Validate that all agents in the manifest are registered ──
        // Hub dispatch requires every custom agent to be in the org's
        // agent_catalog. System agents always pass. Version pins are
        // checked against exact versions.
        if (manifest_yaml && team) {
            const scope = await Scope.findByPk(team.scope_id);
            if (scope?.org_id) {
                const { validate_agents_for_dispatch } = await import('../lib/agent_catalog_usage.js');
                const agent_check = await validate_agents_for_dispatch(scope.org_id, manifest_yaml);
                if (!agent_check.ok) {
                    const details = agent_check.missing
                        .map((m) => m.required_version
                            ? `${m.name}@${m.required_version} (${m.reason})`
                            : `${m.name} (${m.reason})`)
                        .join(', ');
                    throw ApiError.bad_request(
                        `Cannot dispatch: unregistered agents: ${details}. Register them with 'cliq agent register <name>' or remove them from the team manifest.`,
                    );
                }
            }
        }

        const run_id = await RunService.create(input.workspace_id, input.team_id, {
            daemon_id: daemon.id,
            realm_id: input.realm_id,
            run_name: input.run_name,
            inputs: input.run_context.inputs,
            external_id: input.run_context.id,
            context_labels: input.run_context.labels,
            execution_type: input.execution_type,
        });

        const team_scope_slug = team
            ? (await Scope.findByPk(team.scope_id))?.slug
            : undefined;

        // Enqueue the execute command for durable delivery via the outbox.
        await command_outbox_enqueue(daemon.id, '/v1/execute', {
            run_id,
            workspace_dir: workspace_path,
            manifest_yaml,
            team_id: input.team_id,
            ...(team_scope_slug && team ? { scope: team_scope_slug, slug: team.slug } : {}),
            run_context: input.run_context,
            run_name: input.run_name,
            execution_type: input.execution_type ?? 'local',
            ...(input.queue_item_id ? { queue_item_id: input.queue_item_id } : {}),
        });

        log.info('execute_dispatched', {
            run_id,
            daemon_id: daemon.id,
            team_id: input.team_id,
            workspace_id: input.workspace_id,
            queue_item_id: input.queue_item_id ?? null,
        });
        return {
            run_id,
            daemon_id: daemon.id,
            accepted: true,
        };
    }

    /**
     * Cancel a run. One verb for the operator:
     *   1. Daemon reachable → enqueue `/v1/cancel` (daemon stops the process).
     *   2. Daemon unreachable / cancel already stale → Hub-side mark cancelled
     *      (`force_terminated_at`) so the dashboard is honest. Does not kill
     *      a wedged process on the machine — operator may still need to restart cliqd.
     */
    static async cancel_run(
        run_id: string,
        _org_ids: string[] = [],
        user_id?: string,
        reason?: string,
    ): Promise<{ cancelled: boolean; mode: 'queued' | 'hub_terminated' | 'already_terminal' }> {
        if (!user_id) throw ApiError.forbidden('Not authenticated');

        const run = await Run.findByPk(run_id);
        if (!run) throw ApiError.not_found(`Run '${run_id}' not found`);
        await DispatchService._ensure_daemon_assignment(run);

        // Assert observer access BEFORE reachability so callers can't probe
        // daemon liveness via cancel error codes.
        if (run.daemon_id) {
            await AccessService.assert_can_observe_daemon(user_id, run.daemon_id);
        }

        const state = run.state;
        if (state && !['running', 'awaiting_input'].includes(state)) {
            return { cancelled: true, mode: 'already_terminal' };
        }

        const eligibility = await DispatchService._force_terminate_eligibility(run);

        let daemon: InstanceType<typeof Daemon> | null = null;
        let unreachable_code: string | null = null;
        try {
            daemon = await DispatchService._check_daemon_reachable(run);
        } catch (err) {
            const code = (err as { code?: string })?.code;
            if (
                code === 'run/daemon_offline'
                || code === 'run/daemon_stranded'
                || code === 'run/stranded'
            ) {
                unreachable_code = code;
            } else {
                throw err;
            }
        }

        // Escalate to Hub-side terminate when the daemon can't take the command,
        // or when eligibility already says the run is stuck (stale cancel / lease).
        if (unreachable_code !== null || eligibility.eligible) {
            const trigger: 'stale_cancel' | 'daemon_offline' | 'lease_expired' =
                eligibility.eligible
                    ? eligibility.trigger
                    : 'daemon_offline';
            await DispatchService._hub_side_cancel(run, user_id, reason, trigger);
            return { cancelled: true, mode: 'hub_terminated' };
        }

        await command_outbox_enqueue(daemon!.id, '/v1/cancel', { run_id });

        const { HugReviewsService } = await import('./hug_reviews.service.js');
        await HugReviewsService.expire_pending_for_run(run_id).catch(() => {});

        log.info(`dispatched cancel run ${run_id} to daemon ${run.daemon_id}`);
        return { cancelled: true, mode: 'queued' };
    }

    /**
     * User-facing "resume this run from a specific phase". Verifies
     * the caller can observe the run's owning daemon, then enqueues
     * a /v1/resume command in the daemon outbox (delivered
     * at-least-once).
     *
     * The daemon endpoint (POST /v1/resume) requires both run_id
     * and from_phase; there is no "resume where you left off"
     * variant from the Hub, so from_phase is required on the wire.
     */
    static async resume(
        run_id: string,
        from_phase: string,
        _org_ids: string[] = [],
        user_id?: string,
    ): Promise<{ resumed: boolean; from_phase: string }> {
        if (!user_id) throw ApiError.forbidden('Not authenticated');

        const run = await Run.findByPk(run_id);
        if (!run) throw ApiError.not_found(`Run '${run_id}' not found`);
        await DispatchService._ensure_daemon_assignment(run);

        if (run.daemon_id) {
            await AccessService.assert_can_observe_daemon(user_id, run.daemon_id);
        }

        const daemon = await DispatchService._check_daemon_reachable(run);

        await command_outbox_enqueue(daemon.id, '/v1/resume', { run_id, from_phase });

        log.info(`dispatched resume run ${run_id} from_phase='${from_phase}' to daemon ${run.daemon_id}`);
        return { resumed: true, from_phase };
    }

    /**
     * Hub-side mark cancelled when the daemon cannot (or will not) ack
     * a normal cancel. Stamps `force_terminated_at` so a reconnecting
     * daemon cannot un-terminate the run by reporting `running`.
     *
     * Does NOT kill the process on the daemon machine.
     */
    private static async _hub_side_cancel(
        run: InstanceType<typeof Run>,
        user_id: string,
        reason: string | undefined,
        trigger: 'stale_cancel' | 'daemon_offline' | 'lease_expired',
    ): Promise<void> {
        const run_id = run.run_id;
        const now = Date.now();
        const error_msg = reason
            ? `cancelled by user ${user_id} — ${reason}`
            : `cancelled by user ${user_id} — daemon unresponsive (${trigger})`;

        const sq = get_sequelize();
        await sq.query(
            `UPDATE cliq."team_runs"
                SET "state" = 'cancelled',
                    "completed_at" = :now,
                    "lease_expires_at" = NULL,
                    "error" = :error,
                    "force_terminated_at" = :now,
                    "force_terminated_by_user_id" = :user_id,
                    "force_terminated_reason" = :reason
              WHERE "run_id" = :run_id`,
            {
                replacements: {
                    now, run_id, user_id,
                    error: error_msg,
                    reason: reason ?? null,
                },
                type: QueryTypes.UPDATE,
            },
        );

        await sq.query(
            `UPDATE cliq."command_outbox"
                SET "attempts" = "max_attempts",
                    "error" = COALESCE("error" || ' | ', '') || 'superseded by Hub cancel (daemon unreachable)'
              WHERE "endpoint" = '/v1/cancel'
                AND "acked_at" IS NULL
                AND "payload"->>'run_id' = :run_id`,
            {
                replacements: { run_id },
                type: QueryTypes.UPDATE,
            },
        );

        log.info('run_hub_cancelled', {
            run_id, daemon_id: run.daemon_id,
            by_user: user_id, trigger,
        });

        const { HugReviewsService } = await import('./hug_reviews.service.js');
        await HugReviewsService.expire_pending_for_run(run_id).catch(() => {});
    }

    /**
     * Decide whether a run looks stuck enough that cancel should mark
     * Hub cancelled immediately (used by cancel escalation + SPA status).
     */
    private static async _force_terminate_eligibility(
        run: InstanceType<typeof Run>,
    ): Promise<
        | { eligible: true; trigger: 'stale_cancel' | 'daemon_offline' | 'lease_expired' }
        | { eligible: false; blocker: string }
    > {
        const now = Date.now();

        const sq = get_sequelize();
        const stale_cancel_ms = 5 * 60 * 1000;
        const stale_cancel_rows = await sq.query<{ oldest_created_at: string | null }>(
            `SELECT MIN("created_at")::TEXT AS "oldest_created_at"
               FROM cliq."command_outbox"
              WHERE "endpoint" = '/v1/cancel'
                AND "acked_at" IS NULL
                AND "attempts" < "max_attempts"
                AND "payload"->>'run_id' = :run_id`,
            {
                replacements: { run_id: run.run_id },
                type: QueryTypes.SELECT,
            },
        );
        const oldest = stale_cancel_rows[0]?.oldest_created_at;
        if (oldest !== null && oldest !== undefined) {
            const age_ms = now - Number(oldest);
            if (age_ms >= stale_cancel_ms) {
                return { eligible: true, trigger: 'stale_cancel' };
            }
        }

        const daemon_stale_ms = 90 * 1000;
        if (run.daemon_id) {
            const daemon = await Daemon.findByPk(run.daemon_id);
            const last_hb = daemon?.last_heartbeat ?? 0;
            if (!daemon || last_hb === 0 || (now - last_hb) >= daemon_stale_ms) {
                return { eligible: true, trigger: 'daemon_offline' };
            }
        }

        const lease = run.lease_expires_at ?? 0;
        if (lease > 0 && lease < now) {
            return { eligible: true, trigger: 'lease_expired' };
        }

        return {
            eligible: false,
            blocker: 'daemon is heartbeating and no cancel has been queued long enough',
        };
    }

    /** Supply missing inputs to a run waiting on the daemon, then mirror state on Hub. */
    static async supply_inputs(input: {
        run_id: string;
        inputs: Record<string, unknown>;
        user_id: string;
    }): Promise<{ supplied: boolean; run_id: string }> {
        if (!input.user_id) throw ApiError.forbidden('Not authenticated');
        if (!input.inputs || Object.keys(input.inputs).length === 0) {
            throw ApiError.bad_request('inputs must not be empty');
        }

        const run = await Run.findByPk(input.run_id);
        if (!run) throw ApiError.not_found(`Run '${input.run_id}' not found`);
        await DispatchService._ensure_daemon_assignment(run);

        if (run.daemon_id) {
            await AccessService.assert_can_observe_daemon(input.user_id, run.daemon_id);
        }

        const daemon = await DispatchService._check_daemon_reachable(run);

        await command_outbox_enqueue(daemon.id, '/v1/runs/supply_inputs', {
            run_id: input.run_id,
            inputs: input.inputs,
        });

        try {
            await RunService.set_inputs(input.run_id, input.inputs);
            await RunService.resume(input.run_id);
        } catch {
            /* daemon is source of truth; Hub mirror is best-effort */
        }

        log.info(`dispatched supply_inputs for run ${input.run_id} to daemon ${daemon.id}`);
        return { supplied: true, run_id: input.run_id };
    }

    /**
     * Install a Hub catalog team onto daemon(s) by POSTing directly.
     * - `daemon_ids` → those daemons (1..n)
     * - `realm_id` → every online daemon in that realm
     *
     * `team_id` may be a Hub registry numeric ID or a "scope/name" string.
     * Fetches the latest published version and sends the manifest to the daemon.
     */
    static async install_team(input: InstallTeamInput): Promise<InstallTeamResult> {
        if (!input.user_id) throw ApiError.forbidden('Not authenticated');

        const daemon_ids = (input.daemon_ids ?? []).map((id) => id.trim()).filter(Boolean);
        if (daemon_ids.length > 0 && input.realm_id) {
            throw ApiError.bad_request('Provide either daemon_ids or realm_id, not both');
        }
        if (daemon_ids.length === 0 && !input.realm_id) {
            throw ApiError.bad_request('Install requires daemon_ids or realm_id');
        }

        const resolved = await DispatchService._resolve_hub_team(input.team_id);
        if (resolved) {
            /** Use the requested version if specified, otherwise latest. */
            let target_version = resolved.version;
            if (input.version && input.version !== resolved.version.version) {
                const specific = await TeamVersion.findOne({
                    where: { team_id: resolved.team.id, version: input.version },
                });
                if (!specific) {
                    throw ApiError.not_found(`Version ${input.version} not found for team '${input.team_id}'`);
                }
                target_version = specific;
            }
            const { team: hub_team } = resolved;
            const latest_version = target_version;
            const scope_slug = hub_team.scope ?? '';

            const targets = await DispatchService._resolve_install_targets({
                ...input,
                daemon_ids,
            });
            if (targets.length === 0) {
                throw ApiError.not_found('No daemon for install');
            }

            const manifest = latest_version.workflow_json;
            const results: InstallDaemonResult[] = [];
            let last_team_id = '';

            for (const daemon of targets) {
                try {
                    const daemon_team = await DispatchService._ensure_daemon_team_row({
                        daemon_id: daemon.id,
                        scope_slug,
                        slug: hub_team.name,
                        version: latest_version.version,
                        description: hub_team.description ?? null,
                        manifest,
                    });
                    last_team_id = daemon_team.id;

                    // Enqueue install command for durable delivery.
                    await command_outbox_enqueue(daemon.id, '/v1/install', {
                        scope: scope_slug,
                        slug: hub_team.name,
                        manifest,
                        version: latest_version.version,
                        description: hub_team.description ?? undefined,
                        team_id: daemon_team.id,
                        agent_settings: input.agent_settings,
                        ...(input.force ? { force: true } : {}),
                    });

                    results.push({ daemon_id: daemon.id, ok: true });
                } catch (err) {
                    results.push({
                        daemon_id: daemon.id,
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            if (!results.some((r) => r.ok)) {
                throw ApiError.bad_request(
                    `Install failed on all targets: ${results.map((r) => `${r.daemon_id}: ${r.error}`).join('; ')}`,
                );
            }

            DispatchService._register_manifest_events(manifest, input.realm_id ?? null, hub_team.name).catch(() => {});

            return { team_id: last_team_id || String(hub_team.id), results };
        }

        const team = await Team.findByPk(input.team_id);
        if (!team) throw ApiError.not_found(`Team '${input.team_id}' not found`);

        AccessService.assert_scope_access(input.scope_ids ?? [], team.scope_id);

        const scope = await Scope.findByPk(team.scope_id);
        if (!scope) throw ApiError.not_found(`Scope for team '${input.team_id}' not found`);

        const targets = await DispatchService._resolve_install_targets({
            ...input,
            daemon_ids,
        });
        if (targets.length === 0) {
            throw ApiError.not_found('No daemon for install');
        }

        const results: InstallDaemonResult[] = [];
        let last_team_id = team.id;

        for (const daemon of targets) {
            try {
                const daemon_team = await DispatchService._ensure_daemon_team_row({
                    daemon_id: daemon.id,
                    scope_slug: scope.slug,
                    slug: team.slug,
                    version: team.version,
                    description: team.description,
                    manifest: team.manifest,
                    dockerfile: team.dockerfile,
                    dependencies: team.dependencies,
                    // An unbound team row (daemon_id === null) is
                    // adoptable by the target daemon — the existing
                    // guard inside _ensure_daemon_team_row rebinds it
                    // and returns the same id. Without this the input
                    // team is orphaned and a fresh id is minted, which
                    // breaks call-site expectations that "install
                    // this team on this daemon" preserves the id.
                    preferred_id: !team.daemon_id || team.daemon_id === daemon.id ? team.id : undefined,
                });
                last_team_id = daemon_team.id;

                // Enqueue install command for durable delivery.
                await command_outbox_enqueue(daemon.id, '/v1/install', {
                    scope: scope.slug,
                    slug: team.slug,
                    manifest: team.manifest,
                    version: team.version ?? undefined,
                    description: team.description ?? undefined,
                    team_id: daemon_team.id,
                    agent_settings: input.agent_settings,
                    ...(input.force ? { force: true } : {}),
                });

                results.push({ daemon_id: daemon.id, ok: true });
            } catch (err) {
                results.push({
                    daemon_id: daemon.id,
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        if (!results.some((r) => r.ok)) {
            throw ApiError.bad_request(
                `Install failed on all targets: ${results.map((r) => `${r.daemon_id}: ${r.error}`).join('; ')}`,
            );
        }

        return { team_id: last_team_id, results };
    }

    /**
     * Enqueue realm work. Exclusive kinds (`run`) sit until claim/offer (Slice 3).
     * Fan-out kinds (`install` / `uninstall`) run existing verbs and store results on the row.
     */
    static async enqueue(input: {
        realm_id: string;
        kind: 'run' | 'install' | 'uninstall';
        payload?: Record<string, unknown>;
        priority?: number;
        user_id: string;
        scope_ids?: string[];
        org_ids?: string[];
    }): Promise<{ item: Queue_item_dto }> {
        if (!input.user_id) throw ApiError.forbidden('Not authenticated');
        const realm_id = input.realm_id.trim();
        if (!realm_id) throw ApiError.bad_request('realm_id is required');

        await RealmService.assert_member(realm_id, input.user_id);

        const payload = input.payload ?? {};
        const fan_out = input.kind === 'install' || input.kind === 'uninstall';
        const item = await QueueService.create({
            realm_id,
            kind: input.kind,
            payload,
            priority: input.priority,
            submitted_by: input.user_id,
            status: fan_out ? 'dispatching' : 'queued',
        });

        log.info('queue_enqueued', {
            queue_item_id: item.id,
            realm_id: item.realm_id,
            kind: item.kind,
            status: item.status,
            priority: item.priority,
            submitted_by: item.submitted_by,
            team_id: typeof payload.team_id === 'string' ? payload.team_id : null,
        });

        if (input.kind === 'install') {
            return DispatchService._enqueue_install(item, payload, input);
        }

        if (input.kind === 'uninstall') {
            return DispatchService._enqueue_uninstall(item, payload, input);
        }

        if (input.kind === 'run') {
            return DispatchService.offer_and_dispatch_run(item, input);
        }

        return { item };
    }

    /**
     * Public install entry used by `/teams/install` — always audits via the queue.
     * Accepts `realm_id` (fleet) or `daemon_ids` (pinned); resolves a queue realm when needed.
     */
    static async install_via_queue(input: InstallTeamInput): Promise<QueuedInstallResult> {
        if (!input.user_id) throw ApiError.forbidden('Not authenticated');
        const daemon_ids = (input.daemon_ids ?? []).map((id) => id.trim()).filter(Boolean);
        const realm_id = await DispatchService._resolve_queue_realm_id({
            user_id: input.user_id,
            realm_id: input.realm_id,
            daemon_ids,
        });

        const { item } = await DispatchService.enqueue({
            realm_id,
            kind: 'install',
            payload: {
                team_id: input.team_id,
                ...(daemon_ids.length > 0 ? { daemon_ids } : {}),
                ...(input.agent_settings ? { agent_settings: input.agent_settings } : {}),
                ...(input.force ? { force: true } : {}),
                ...(input.version ? { version: input.version } : {}),
            },
            user_id: input.user_id,
            scope_ids: input.scope_ids,
            org_ids: input.org_ids,
        });

        return {
            item,
            team_id: typeof item.payload.team_id === 'string' ? item.payload.team_id : input.team_id,
            results: (item.results as InstallDaemonResult[] | null) ?? [],
        };
    }

    /**
     * Public uninstall entry — fleet (`realm_id`) or pinned (`daemon_ids` / legacy single).
     * Always audits via the queue.
     */
    static async uninstall_via_queue(input: UninstallTeamInput): Promise<QueuedUninstallResult> {
        if (!input.user_id) throw ApiError.forbidden('Not authenticated');
        const scope = input.scope.trim();
        const slug = input.slug.trim();
        if (!scope || !slug) throw ApiError.bad_request('scope and slug are required');

        const daemon_ids = (input.daemon_ids ?? []).map((id) => id.trim()).filter(Boolean);
        const realm_id = await DispatchService._resolve_queue_realm_id({
            user_id: input.user_id,
            realm_id: input.realm_id,
            daemon_ids,
        });

        const { item } = await DispatchService.enqueue({
            realm_id,
            kind: 'uninstall',
            payload: {
                scope,
                slug,
                ...(daemon_ids.length > 0 ? { daemon_ids } : {}),
            },
            user_id: input.user_id,
            org_ids: input.org_ids,
        });

        return {
            item,
            scope,
            slug,
            results: (item.results as UninstallDaemonResult[] | null) ?? [],
        };
    }

    /** Fan-out uninstall to daemon_ids or all online daemons in realm (no queue). */
    static async uninstall_team(input: UninstallTeamInput): Promise<UninstallTeamResult> {
        if (!input.user_id) throw ApiError.forbidden('Not authenticated');
        const scope = input.scope.trim();
        const slug = input.slug.trim();
        if (!scope || !slug) throw ApiError.bad_request('scope and slug are required');

        const daemon_ids = (input.daemon_ids ?? []).map((id) => id.trim()).filter(Boolean);
        if (daemon_ids.length > 0 && input.realm_id) {
            throw ApiError.bad_request('Provide either daemon_ids or realm_id, not both');
        }
        if (daemon_ids.length === 0 && !input.realm_id) {
            throw ApiError.bad_request('Uninstall requires daemon_ids or realm_id');
        }

        const targets = await DispatchService._resolve_install_targets({
            team_id: '',
            user_id: input.user_id,
            daemon_ids: daemon_ids.length > 0 ? daemon_ids : undefined,
            realm_id: input.realm_id,
        });
        if (targets.length === 0) {
            throw ApiError.not_found('No daemon for uninstall');
        }

        const results: UninstallDaemonResult[] = [];
        for (const daemon of targets) {
            try {
                await command_outbox_enqueue(daemon.id, '/v1/uninstall', {
                    scope,
                    slug,
                });
                results.push({ daemon_id: daemon.id, ok: true });
            } catch (err) {
                results.push({
                    daemon_id: daemon.id,
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        if (!results.some((r) => r.ok)) {
            throw ApiError.bad_request(
                `Uninstall failed on all targets: ${results.map((r) => `${r.daemon_id}: ${r.error}`).join('; ')}`,
            );
        }

        if (input.realm_id) {
            DispatchService._cleanup_orphaned_realm_settings(input.realm_id).catch(() => {});
        }

        return { scope, slug, results };
    }

    private static async _enqueue_install(
        item: Queue_item_dto,
        payload: Record<string, unknown>,
        input: { user_id: string; scope_ids?: string[]; org_ids?: string[] },
    ): Promise<{ item: Queue_item_dto }> {
        const team_id = typeof payload.team_id === 'string' ? payload.team_id.trim() : '';
        if (!team_id) {
            await QueueService.set_results(item.id, {
                status: 'failed',
                error: 'install payload requires team_id',
            });
            throw ApiError.bad_request('install payload requires team_id');
        }

        const pinned = Array.isArray(payload.daemon_ids)
            ? payload.daemon_ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
                .map((id) => id.trim())
            : [];

        const agent_settings = payload.agent_settings as Record<string, Record<string, string>> | undefined;
        const force = payload.force === true;
        const version = typeof payload.version === 'string' ? payload.version : undefined;

        try {
            const install = await DispatchService.install_team({
                team_id,
                user_id: input.user_id,
                scope_ids: input.scope_ids,
                org_ids: input.org_ids,
                agent_settings,
                ...(force ? { force: true } : {}),
                ...(version ? { version } : {}),
                ...(pinned.length > 0
                    ? { daemon_ids: pinned }
                    : { realm_id: item.realm_id }),
            });
            const any_fail = install.results.some((r) => !r.ok);
            const updated = await QueueService.set_results(item.id, {
                status: any_fail ? 'partial' : 'completed',
                results: install.results,
            });
            return { item: updated };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await QueueService.set_results(item.id, {
                status: 'failed',
                error: message,
            });
            throw err;
        }
    }

    private static async _enqueue_uninstall(
        item: Queue_item_dto,
        payload: Record<string, unknown>,
        input: { user_id: string; org_ids?: string[] },
    ): Promise<{ item: Queue_item_dto }> {
        const scope = typeof payload.scope === 'string' ? payload.scope.trim() : '';
        const slug = typeof payload.slug === 'string' ? payload.slug.trim() : '';
        if (!scope || !slug) {
            await QueueService.set_results(item.id, {
                status: 'failed',
                error: 'uninstall payload requires scope and slug',
            });
            throw ApiError.bad_request('uninstall payload requires scope and slug');
        }

        const pinned = Array.isArray(payload.daemon_ids)
            ? payload.daemon_ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
                .map((id) => id.trim())
            : [];

        try {
            const uninstall = await DispatchService.uninstall_team({
                scope,
                slug,
                user_id: input.user_id,
                org_ids: input.org_ids,
                ...(pinned.length > 0
                    ? { daemon_ids: pinned }
                    : { realm_id: item.realm_id }),
            });
            const any_fail = uninstall.results.some((r) => !r.ok);
            const updated = await QueueService.set_results(item.id, {
                status: any_fail ? 'partial' : 'completed',
                results: uninstall.results,
            });
            return { item: updated };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await QueueService.set_results(item.id, {
                status: 'failed',
                error: message,
            });
            throw err;
        }
    }

    /**
     * Realm for the queue row: explicit realm_id, else intersection of user realms
     * that contain every pinned daemon.
     */
    private static async _resolve_queue_realm_id(input: {
        user_id: string;
        realm_id?: string;
        daemon_ids: string[];
    }): Promise<string> {
        const explicit = input.realm_id?.trim() ?? '';
        if (explicit) {
            await RealmService.assert_member(explicit, input.user_id);
            return explicit;
        }

        if (input.daemon_ids.length === 0) {
            throw ApiError.bad_request('Provide realm_id or daemon_ids');
        }

        const user_realm_ids = new Set(await RealmService.list_realm_ids_for_user(input.user_id));
        const by_daemon = await RealmService.list_realms_by_daemon_ids(input.daemon_ids);

        let candidates: string[] | null = null;
        for (const daemon_id of input.daemon_ids) {
            const realms = (by_daemon.get(daemon_id) ?? [])
                .map((r) => r.id)
                .filter((id) => user_realm_ids.has(id));
            if (candidates === null) {
                candidates = realms;
                continue;
            }
            const set = new Set(realms);
            candidates = candidates.filter((id) => set.has(id));
        }

        const realm_id = candidates?.[0];
        if (!realm_id) {
            throw ApiError.bad_request(
                'Pinned daemons do not share a realm you belong to; pass realm_id',
            );
        }
        return realm_id;
    }

    /**
     * Exclusive run path (path B): offer to online realm daemons → one claims → Hub executes on winner.
     * Pre-filters daemons to those whose cached team roster includes the requested team.
     */
    static async offer_and_dispatch_run(
        item: Queue_item_dto,
        input: {
            user_id: string;
            scope_ids?: string[];
            org_ids?: string[];
        },
    ): Promise<{ item: Queue_item_dto }> {
        let daemon_ids = await RealmService.list_online_daemon_ids_in_realm(
            item.realm_id,
            input.user_id,
        );
        if (daemon_ids.length === 0) {
            log.warn('offer_skipped_no_daemons', {
                queue_item_id: item.id,
                realm_id: item.realm_id,
                kind: item.kind,
            });
            const failed = await QueueService.set_results(item.id, {
                status: 'failed',
                error: 'No online daemons in this realm — enroll a daemon and retry',
            });
            throw Object.assign(
                ApiError.bad_request('No online daemons in this realm — enroll a daemon and retry'),
                { queue_item: failed },
            );
        }

        const team_id = typeof item.payload?.team_id === 'string'
            ? item.payload.team_id.trim()
            : '';

        if (team_id) {
            const eligible_daemon_ids = await DispatchService._daemon_ids_with_team(
                team_id,
                daemon_ids,
            );
            if (eligible_daemon_ids.length > 0) {
                const before = daemon_ids.length;
                daemon_ids = eligible_daemon_ids;
                log.info('offer_prefilter_team', {
                    queue_item_id: item.id,
                    realm_id: item.realm_id,
                    team_id,
                    online_count: before,
                    eligible_count: daemon_ids.length,
                });
            }
            // If no daemon has the team cached, fall through to offer all (backward compat).
        }

        const daemons = await Daemon.findAll({
            where: { id: { [Op.in]: daemon_ids }, status: 'online' },
        });
        if (daemons.length === 0) {
            log.warn('offer_skipped_no_daemons', {
                queue_item_id: item.id,
                realm_id: item.realm_id,
                kind: item.kind,
                reason: 'filtered_offline',
            });
            const failed = await QueueService.set_results(item.id, {
                status: 'failed',
                error: 'No online daemons available to claim this run',
            });
            throw Object.assign(
                ApiError.bad_request('No online daemons available to claim this run'),
                { queue_item: failed },
            );
        }

        await QueueService.mark_offered(item.id);

        log.info('offer_fanout_start', {
            queue_item_id: item.id,
            realm_id: item.realm_id,
            daemon_count: daemons.length,
            team_id: team_id || null,
        });

        // offer_job uses direct HTTP (not the outbox) because the claim
        // check immediately follows — the daemon must claim synchronously
        // before we inspect the queue status.
        await Promise.all(
            daemons.map(async (daemon) => {
                try {
                    await DispatchService._post_to_daemon(daemon, '/v1/offer_job', {
                        queue_item_id: item.id,
                        daemon_id: daemon.id,
                        kind: 'run',
                        payload: item.payload,
                    });
                } catch (err) {
                    log.warn('offer_job_failed', {
                        queue_item_id: item.id,
                        realm_id: item.realm_id,
                        daemon_id: daemon.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }),
        );

        const after_offer = await QueueService.get(item.id);
        if (after_offer.status !== 'claimed' || !after_offer.claimed_by) {
            const message = 'No daemon claimed the run — check that a realm daemon is online and reachable from Hub';
            log.warn('offer_unclaimed', {
                queue_item_id: after_offer.id,
                realm_id: after_offer.realm_id,
                status: after_offer.status,
                daemon_count: daemons.length,
            });
            const failed = await QueueService.set_results(after_offer.id, {
                status: 'failed',
                error: message,
            });
            throw Object.assign(ApiError.bad_request(message), { queue_item: failed });
        }

        log.info('offer_claimed', {
            queue_item_id: after_offer.id,
            realm_id: after_offer.realm_id,
            daemon_id: after_offer.claimed_by,
        });

        try {
            const dispatched = await DispatchService.dispatch_claimed_run(after_offer, input);
            return { item: dispatched };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error('dispatch_claimed_run_failed', {
                queue_item_id: after_offer.id,
                realm_id: after_offer.realm_id,
                daemon_id: after_offer.claimed_by,
                error: message,
            });
            const failed = await QueueService.set_results(after_offer.id, {
                status: 'failed',
                error: message,
            });
            throw Object.assign(err instanceof Error ? err : new Error(message), {
                queue_item: failed,
            });
        }
    }

    /** After exclusive claim: create Hub run + POST /v1/execute to the winner only. */
    static async dispatch_claimed_run(
        item: Queue_item_dto,
        input: {
            user_id: string;
            scope_ids?: string[];
            org_ids?: string[];
        },
    ): Promise<Queue_item_dto> {
        if (item.kind !== 'run') {
            throw ApiError.bad_request('dispatch_claimed_run requires kind=run');
        }
        if (!item.claimed_by) {
            throw ApiError.conflict(`Queue item '${item.id}' is not claimed`);
        }

        const payload = item.payload ?? {};
        const team_ref = typeof payload.team_id === 'string' ? payload.team_id.trim() : '';
        if (!team_ref) {
            throw ApiError.bad_request('run payload requires team_id');
        }

        const resolved_team = await DispatchService._resolve_daemon_team_id(
            team_ref,
            item.claimed_by,
        );

        const requested_workspace_id = typeof payload.workspace_id === 'string'
            ? payload.workspace_id.trim()
            : '';
        const requested_workspace_path = typeof payload.workspace_path === 'string'
            ? payload.workspace_path.trim()
            : '';

        const resolved_workspace = await DispatchService._resolve_workspace_for_run(
            item.claimed_by,
            requested_workspace_id,
            requested_workspace_path,
        );

        const raw_context = payload.run_context;
        let run_context: {
            id?: string;
            labels?: Record<string, string>;
            inputs?: Record<string, unknown>;
        } = {};
        if (raw_context && typeof raw_context === 'object' && !Array.isArray(raw_context)) {
            run_context = raw_context as {
                id?: string;
                labels?: Record<string, string>;
                inputs?: Record<string, unknown>;
            };
        } else if (payload.inputs && typeof payload.inputs === 'object') {
            run_context = { inputs: payload.inputs as Record<string, unknown> };
        }

        log.info('dispatch_claimed_run_start', {
            queue_item_id: item.id,
            realm_id: item.realm_id,
            daemon_id: item.claimed_by,
            team_ref,
            team_id: resolved_team.team_id,
            workspace_id: resolved_workspace.workspace_id,
            workspace_path: resolved_workspace.workspace_path || null,
        });

        const result = await DispatchService.dispatch_run({
            workspace_id: resolved_workspace.workspace_id,
            team_id: resolved_team.team_id,
            daemon_id: item.claimed_by,
            workspace_path: resolved_workspace.workspace_path || undefined,
            manifest_yaml: typeof payload.manifest_yaml === 'string'
                ? payload.manifest_yaml
                : resolved_team.manifest,
            run_context,
            run_name: typeof payload.run_name === 'string' ? payload.run_name : undefined,
            execution_type: payload.execution_type === 'docker' ? 'docker' : 'local',
            user_id: input.user_id,
            scope_ids: input.scope_ids,
            org_ids: input.org_ids,
            realm_id: item.realm_id,
            queue_item_id: item.id,
        });

        return QueueService.set_results(item.id, {
            status: 'running',
            run_id: result.run_id,
        });
    }

    /**
     * Query a daemon endpoint and return its response directly.
     * Used to proxy live data (workspaces, teams) from the daemon.
     * Wraps the payload in a MessageEnvelope as required by the daemon protocol.
     *
     * NOTE: This is intentionally kept as inline POST (not outboxed) because
     * the caller needs a synchronous response. A future iteration will convert
     * to async via command_outbox with ack payloads (design task 4.15).
     */
    static async query_daemon(
        daemon_id: string,
        path: string,
        payload: Record<string, unknown>,
        user_id: string,
        message_type: string = 'workspace_list',
    ): Promise<unknown> {
        if (!user_id) throw ApiError.forbidden('Not authenticated');

        const daemon = await Daemon.findByPk(daemon_id);
        if (!daemon) throw ApiError.not_found(`Daemon '${daemon_id}' not found`);

        await AccessService.assert_can_observe_daemon(user_id, daemon.id);

        const envelope = {
            version: 1,
            id: randomUUID(),
            timestamp: Date.now(),
            run_id: null,
            instance_id: null,
            type: message_type,
            payload,
        };

        const resp = await DispatchService._post_to_daemon(daemon, path, envelope);
        if (resp.status < 200 || resp.status >= 300) {
            const msg = DispatchService._extract_error_message(resp.body);
            throw ApiError.service_unavailable(`Daemon query failed: ${msg}`);
        }

        return resp.body;
    }

    /** Dispatch team uninstall from a daemon. */
    static async dispatch_uninstall(input: DispatchUninstallInput): Promise<{ dispatched: boolean }> {
        if (!input.user_id) throw ApiError.forbidden('Not authenticated');

        const daemon = await Daemon.findByPk(input.daemon_id);
        if (!daemon) throw ApiError.not_found(`Daemon '${input.daemon_id}' not found`);

        await AccessService.assert_can_observe_daemon(input.user_id, daemon.id);

        await command_outbox_enqueue(daemon.id, '/v1/uninstall', {
            scope: input.scope,
            slug: input.slug,
        });

        log.info(`dispatched uninstall @${input.scope}/${input.slug} from daemon ${daemon.id}`);
        return { dispatched: true };
    }

    /**
     * Admin proxy — POST an arbitrary control body to a specific
     * daemon's `public_url`, gated by "can this user observe this
     * daemon" and returning the raw `{ status, body }` so the
     * calling controller can translate the failure surface.
     *
     * Used by the daemon outbox management routes (retry / purge /
     * inspect / status). The daemon-side routes read `req.body`
     * directly, so unlike `query_daemon()` we DO NOT wrap the body
     * in an SDK envelope — pass the raw admin payload as-is and it
     * arrives as `req.body` on the daemon side (with a `tx_id`
     * merged in automatically for idempotency).
     *
     * Sync-mode daemons transparently receive the call through the
     * relay — no branching needed here.
     */
    static async admin_call_to_daemon(
        user_id: string,
        daemon_id: string,
        path: string,
        body: Record<string, unknown>,
    ): Promise<{ status: number; body: unknown; tx_id: string }> {
        if (!user_id) throw ApiError.forbidden('Not authenticated');

        const daemon = await Daemon.findByPk(daemon_id);
        if (!daemon) throw ApiError.not_found(`Daemon '${daemon_id}' not found`);

        await AccessService.assert_can_observe_daemon(user_id, daemon.id);
        return DispatchService._post_to_daemon(daemon, path, body);
    }

    /**
     * POST a command to a daemon's public_url.
     * For direct daemons this hits the daemon itself.
     * For sync daemons this hits the sync service relay (transparent).
     *
     * Non-loopback daemons require a Hub-signed dispatch JWT once they
     * have loaded a realm dispatch public key — mint one when the daemon
     * has a realm membership.
     *
     * Returns `{ status, body, tx_id }` so callers can handle non-2xx gracefully.
     *
     * Every control hop mints (or reuses) a `tx_id` placed in the JSON **body**
     * so sync can dedupe retries. See DESIGN-control-message-reliability.
     */
    private static async _post_to_daemon(
        daemon: Daemon,
        path: string,
        body: Record<string, unknown>,
        opts?: { tx_id?: string },
    ): Promise<{ status: number; body: unknown; tx_id: string }> {
        if (!daemon.public_url) {
            throw ApiError.bad_request(`Daemon '${daemon.id}' has no public_url configured`);
        }

        if (daemon.status !== 'online') {
            throw ApiError.service_unavailable(`Daemon '${daemon.id}' is offline`);
        }

        const tx_id = opts?.tx_id?.trim() || randomUUID();
        const url = `${daemon.public_url}${path}`;
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'x-requested-with': 'XMLHttpRequest',
        };

        const auth = await DispatchService._dispatch_authorization_header(daemon);
        if (auth) headers.Authorization = auth;

        const payload = { ...body, tx_id };

        log.info('daemon_control_post', {
            tx_id,
            daemon_id: daemon.id,
            path,
        });

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30_000),
        });

        const response_body = await response.json().catch(async () => {
            const text = await response.text().catch(() => '');
            return { ok: false, error: text.slice(0, 200) };
        });

        return { status: response.status, body: response_body, tx_id };
    }

    /**
     * Mint `Authorization: Bearer <dispatch jwt>` for a daemon call.
     * Returns null when the daemon has no realm (no key to sign with).
     */
    private static async _dispatch_authorization_header(
        daemon: Daemon,
    ): Promise<string | null> {
        const realms = await RealmService.list_realms_for_daemon(daemon.id);
        if (realms.length === 0) return null;

        return DispatchAuthService.authorization_header({
            realm_id: realms[0]!.id,
            aud: daemon.id,
            action: 'access',
        });
    }

    /** Extract a human-readable error message from a daemon response body. */
    private static _extract_error_message(body: unknown): string {
        if (!body || typeof body !== 'object') return String(body ?? 'unknown error');
        const obj = body as Record<string, unknown>;
        if (obj.payload && typeof obj.payload === 'object') {
            const payload = obj.payload as Record<string, unknown>;
            if (typeof payload.message === 'string') return payload.message;
        }
        if (obj.error && typeof obj.error === 'object') {
            const err = obj.error as Record<string, unknown>;
            if (typeof err.message === 'string') return err.message;
        }
        if (typeof obj.error === 'string') return obj.error;
        if (typeof obj.message === 'string') return obj.message;
        return JSON.stringify(body).slice(0, 200);
    }

    /**
     * Resolve a run team_ref (UUID or scope/slug) to the claiming daemon's
     * cached team row — required for team_runs FK + execute manifest.
     */
    private static async _resolve_daemon_team_id(
        team_ref: string,
        daemon_id: string,
    ): Promise<{ team_id: string; manifest?: string }> {
        const ref = team_ref.trim().replace(/^@/, '');
        if (!ref) throw ApiError.bad_request('run payload requires team_id');

        const by_pk = await Team.findByPk(ref);
        if (by_pk) {
            if (by_pk.daemon_id === daemon_id) {
                return { team_id: by_pk.id, manifest: by_pk.manifest ?? undefined };
            }

            const on_daemon = await Team.findOne({
                where: {
                    daemon_id,
                    scope_id: by_pk.scope_id,
                    slug: by_pk.slug,
                },
            });
            if (on_daemon) {
                return { team_id: on_daemon.id, manifest: on_daemon.manifest ?? undefined };
            }

            if (!by_pk.daemon_id) {
                throw ApiError.bad_request(
                    `Team '${by_pk.slug}' is not installed on the claiming daemon — apply the realm team list or install it first`,
                );
            }

            throw ApiError.bad_request(
                `Team '${ref}' belongs to another daemon; not installed on '${daemon_id}'`,
            );
        }

        if (!ref.includes('/')) {
            throw ApiError.not_found(`Team '${team_ref}' not found`);
        }

        const slash = ref.indexOf('/');
        const scope_slug = ref.slice(0, slash);
        const slug = ref.slice(slash + 1);
        if (!scope_slug || !slug) {
            throw ApiError.bad_request(`Invalid team_id '${team_ref}' — expected scope/slug or UUID`);
        }

        const scope = await Scope.findOne({ where: { slug: scope_slug } });
        if (!scope) throw ApiError.not_found(`Scope '${scope_slug}' not found`);

        const on_daemon = await Team.findOne({
            where: { daemon_id, scope_id: scope.id, slug },
        });
        if (on_daemon) {
            return { team_id: on_daemon.id, manifest: on_daemon.manifest ?? undefined };
        }

        throw ApiError.bad_request(
            `Team '${scope_slug}/${slug}' is not installed on the claiming daemon — apply the realm team list or install it first`,
        );
    }

    /**
     * Reuse an existing Hub workspace when path/id matches; otherwise create
     * ephemeral. Avoids unique-path Validation errors when the UI passes a
     * path that already exists on the daemon.
     */
    private static async _resolve_workspace_for_run(
        daemon_id: string,
        workspace_id: string,
        workspace_path: string,
    ): Promise<{ workspace_id: string; workspace_path: string }> {
        if (workspace_id) {
            const existing = await Workspace.findByPk(workspace_id);
            if (existing) {
                const path = (existing.path ?? '').startsWith('/')
                    ? existing.path!
                    : (workspace_path.startsWith('/') ? workspace_path : '');
                return { workspace_id: existing.id, workspace_path: path };
            }
        }

        if (workspace_path) {
			const by_path = await Workspace.findOne({
				where: {
					path: workspace_path,
					[Op.or]: [
						{ daemon_id },
						{ daemon_id: { [Op.is]: null } },
					],
				},
				order: [['updated_at', 'DESC']],
			});
            if (by_path) {
                if (by_path.daemon_id && by_path.daemon_id !== daemon_id) {
                    throw ApiError.bad_request(
                        `Workspace path '${workspace_path}' belongs to another daemon`,
                    );
                }
                const abs = by_path.path.startsWith('/') ? by_path.path : workspace_path;
                return { workspace_id: by_path.id, workspace_path: abs };
            }

            const id = randomUUID();
            try {
                await Workspace.create({
                    id,
                    path: workspace_path,
                    name: null,
                    team_id: null,
                    daemon_id,
                    created_at: Date.now(),
                    updated_at: Date.now(),
                });
            } catch (err) {
                const raced = await Workspace.findOne({ where: { path: workspace_path } });
                if (raced) {
                    const abs = raced.path.startsWith('/') ? raced.path : workspace_path;
                    return { workspace_id: raced.id, workspace_path: abs };
                }
                const message = err instanceof Error ? err.message : String(err);
                throw ApiError.bad_request(`Failed to create workspace for path '${workspace_path}': ${message}`);
            }
            return {
                workspace_id: id,
                workspace_path: workspace_path.startsWith('/') ? workspace_path : '',
            };
        }

        const id = randomUUID();
        await Workspace.create({
            id,
            path: `ephemeral/${id}`,
            name: null,
            team_id: null,
            daemon_id,
            created_at: Date.now(),
            updated_at: Date.now(),
        });
        return { workspace_id: id, workspace_path: '' };
    }

    /** Daemons whose cached roster includes the team (by UUID or scope/slug). */
    private static async _daemon_ids_with_team(
        team_ref: string,
        daemon_ids: string[],
    ): Promise<string[]> {
        if (daemon_ids.length === 0) return [];

        const ref = team_ref.trim().replace(/^@/, '');
        if (!ref) return [];

        if (ref.includes('/')) {
            const slash = ref.indexOf('/');
            const scope_slug = ref.slice(0, slash);
            const slug = ref.slice(slash + 1);
            const scope = await Scope.findOne({ where: { slug: scope_slug } });
            if (!scope) return [];
            const rows = await Team.findAll({
                where: {
                    scope_id: scope.id,
                    slug,
                    daemon_id: { [Op.in]: daemon_ids },
                },
                attributes: ['daemon_id'],
            });
            return [...new Set(rows.map((r) => r.daemon_id).filter(Boolean) as string[])];
        }

        const by_id = await Team.findByPk(ref);
        if (!by_id) return [];

        if (by_id.daemon_id && daemon_ids.includes(by_id.daemon_id)) {
            return [by_id.daemon_id];
        }

        const rows = await Team.findAll({
            where: {
                scope_id: by_id.scope_id,
                slug: by_id.slug,
                daemon_id: { [Op.in]: daemon_ids },
            },
            attributes: ['daemon_id'],
        });
        return [...new Set(rows.map((r) => r.daemon_id).filter(Boolean) as string[])];
    }

    /**
     * Validate that all required team inputs are present before dispatch.
     *
     * Looks up the registry team's `capability_json` (which carries the
     * authoritative `inputs` array with `required` flags) and rejects
     * with a 400 if any required input is missing or blank.
     *
     * Best-effort: if the registry lookup fails (e.g. team published
     * externally without a registry entry), the check is skipped and the
     * daemon safety-net catches it instead.
     */
    /**
     * Backfill `run.daemon_id` when it's null but the run clearly ran
     * on some daemon. Historical runs whose daemon-side mirror sent
     * `daemon_id: undefined` to /v1/runs/create end up with a null
     * assignment on Hub even though they executed cleanly — the
     * user then sees "Run 'X' has no daemon assignment" on a run
     * they just watched succeed/fail.
     *
     * Derivation order:
     *   1. realm_dispatch_queue.claimed_by — most reliable (queue
     *      item that spawned this run).
     *   2. command_outbox.daemon_id — any run-scoped command we
     *      shipped went to the daemon that owned the local state.
     *
     * We only derive when the id is null — a deregistered but
     * still-referenced daemon is the caller's problem to surface,
     * not ours to silently rebind (the daemon owns the run's
     * local workspace/phase state).
     *
     * Silently returns on failure — caller still throws
     * bad_request("no daemon assignment") if we can't recover.
     */
    private static async _ensure_daemon_assignment(run: InstanceType<typeof Run>): Promise<void> {
        if (run.daemon_id) return;
        const run_id = run.run_id;
        if (!run_id) return;

        // Tolerate an uninitialised sequelize (early boot / unit tests
        // that don't stub the store) — the caller's daemon-reachability
        // check will still throw a clear `run/stranded` error.
        let sq: ReturnType<typeof get_sequelize>;
        try {
            sq = get_sequelize();
        } catch {
            return;
        }

        // 1. queue claim — the daemon that picked up the offer.
        try {
            const rows = await sq.query<{ claimed_by: string | null }>(
                `SELECT "claimed_by"
                   FROM cliq."realm_dispatch_queue"
                  WHERE "run_id" = :run_id
                    AND "claimed_by" IS NOT NULL
               ORDER BY "claimed_at" DESC NULLS LAST
                  LIMIT 1`,
                { replacements: { run_id }, type: QueryTypes.SELECT },
            );
            const claimed = rows[0]?.claimed_by?.trim();
            if (claimed) {
                await DispatchService._backfill_daemon(run, claimed);
                return;
            }
        } catch {
            /* queue schema may be missing in older test DBs */
        }

        // 2. outbox — any run-scoped command we ever delivered.
        try {
            const rows = await sq.query<{ daemon_id: string | null }>(
                `SELECT "daemon_id"
                   FROM cliq."command_outbox"
                  WHERE "payload"->>'run_id' = :run_id
                    AND "daemon_id" IS NOT NULL
               ORDER BY "created_at" DESC
                  LIMIT 1`,
                { replacements: { run_id }, type: QueryTypes.SELECT },
            );
            const daemon_from_outbox = rows[0]?.daemon_id?.trim();
            if (daemon_from_outbox) {
                await DispatchService._backfill_daemon(run, daemon_from_outbox);
                return;
            }
        } catch {
            /* best-effort */
        }
    }

    /**
     * Stamp `daemon_id` on the run row (raw UPDATE — Sequelize's
     * instance.update() has silently no-op'd on the store's Run model
     * in production, likely due to the daemon_id column being managed
     * by another writer's optimistic-lock hook) and mutate the
     * in-memory instance so the caller can keep going without a
     * re-fetch.
     *
     * Failure mode: log-and-continue. The caller has already derived
     * daemon_id and can enqueue the command with it — losing the
     * backfill just means the next resume/cancel re-derives.
     */
    private static async _backfill_daemon(
        run: InstanceType<typeof Run>,
        daemon_id: string,
    ): Promise<void> {
        // Mutate in-memory first so the caller sees it even if the
        // DB write fails or lags.
        (run as unknown as { daemon_id: string | null }).daemon_id = daemon_id;
        try {
            const sq = get_sequelize();
            await sq.query(
                `UPDATE cliq."team_runs"
                    SET "daemon_id" = :daemon_id
                  WHERE "run_id" = :run_id
                    AND "daemon_id" IS NULL`,
                {
                    replacements: { daemon_id, run_id: run.run_id },
                    type: QueryTypes.UPDATE,
                },
            );
            log.info('backfilled_daemon_assignment', {
                run_id: run.run_id,
                daemon_id,
            });
        } catch (err) {
            log.warn('daemon_backfill_write_failed', {
                run_id: run.run_id,
                daemon_id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Heartbeat window past which the daemon is treated as "offline"
     * (transient — user should wait or retry). Daemons heartbeat every
     * ~30 s, so 60 s is one missed beat plus jitter.
     */
    private static readonly _DAEMON_OFFLINE_MS = 60_000;

    /**
     * Heartbeat window past which the daemon is treated as "stranded"
     * (very unlikely to come back — the pod's ephemeral state is
     * almost certainly gone). At this point resume/supply_inputs
     * against the owning daemon cannot succeed and the UI should
     * offer "Run again" as the only path forward.
     */
    private static readonly _DAEMON_STRANDED_MS = 24 * 60 * 60_000;

    /**
     * Assert the run's owning daemon can accept a command right now.
     * Returns the daemon row on success; throws ApiError.conflict with
     * a machine-readable `code` on failure so the UI can render targeted
     * messaging.
     *
     * Codes returned in the failure envelope:
     *   run/stranded         — daemon_id unresolvable (no queue claim,
     *                          no outbox history). Only path is Run again.
     *   run/daemon_stranded  — daemon row missing OR heartbeat > 24 h.
     *                          Local state is presumed gone. Run again.
     *   run/daemon_offline   — heartbeat 60 s – 24 h ago. Transient;
     *                          waiting a few minutes typically resolves.
     *
     * Callers should invoke this AFTER _ensure_daemon_assignment (which
     * derives daemon_id from queue/outbox for legacy null-daemon rows)
     * and AFTER the AccessService authz check.
     */
    private static async _check_daemon_reachable(
        run: InstanceType<typeof Run>,
    ): Promise<InstanceType<typeof Daemon>> {
        if (!run.daemon_id) {
            throw ApiError.conflict(
                `Run '${run.run_id}' has no daemon assignment — its local state is not recoverable. `
                + 'Start a new run with the same inputs.',
                'run/stranded',
            );
        }

        const daemon = await Daemon.findByPk(run.daemon_id);
        if (!daemon) {
            throw ApiError.conflict(
                `Daemon '${run.daemon_id}' that owned this run no longer exists. `
                + 'Its local state is not recoverable. Start a new run with the same inputs.',
                'run/daemon_stranded',
            );
        }

        const hb_ms = Number((daemon as unknown as { last_heartbeat?: number | string | null }).last_heartbeat ?? 0);
        const hb_age_ms = Date.now() - hb_ms;
        const daemon_label = (daemon as unknown as { name?: string | null }).name ?? run.daemon_id;

        if (!hb_ms || hb_age_ms > DispatchService._DAEMON_STRANDED_MS) {
            throw ApiError.conflict(
                `Daemon '${daemon_label}' has been offline for ${_format_since(hb_age_ms)}. `
                + 'Its local state is not recoverable. Start a new run with the same inputs.',
                'run/daemon_stranded',
            );
        }

        if (hb_age_ms > DispatchService._DAEMON_OFFLINE_MS) {
            throw ApiError.conflict(
                `Daemon '${daemon_label}' is offline (last seen ${_format_since(hb_age_ms)} ago). `
                + 'Wait for it to reconnect and try again, or start a new run.',
                'run/daemon_offline',
            );
        }

        return daemon;
    }

    private static async _validate_required_inputs(
        cp_team: Team | null,
        provided_inputs: Record<string, unknown>,
    ): Promise<void> {
        if (!cp_team) return;

        /** Map from control-plane scope_id → registry scope slug. */
        const scope_row = await Scope.findByPk(cp_team.scope_id);
        if (!scope_row) return;

        const hub_team = await HubTeam.findOne({
            where: { scope: scope_row.slug, name: cp_team.slug },
        });
        if (!hub_team) return;

        const latest_ver = await TeamVersion.findOne({
            where: { team_id: hub_team.id },
            order: [['published_at', 'DESC']],
            attributes: ['capability_json'],
        });
        if (!latest_ver?.capability_json) return;

        let capability: { inputs?: Array<{ name: string; type?: string; required?: boolean }> };
        try {
            capability = JSON.parse(latest_ver.capability_json);
        } catch {
            return;
        }

        const inputs = capability.inputs;
        if (!Array.isArray(inputs)) return;

        /**
         * Coerce channel inputs: callers may send a plain string
         * ("elan") or comma-separated string ("elan,ops-slack")
         * instead of an array. Normalize to string[] before validation.
         */
        for (const inp of inputs) {
            if (inp.type !== 'channel') continue;
            const val = provided_inputs[inp.name];
            if (typeof val === 'string') {
                provided_inputs[inp.name] = val.split(',').map((s) => s.trim()).filter(Boolean);
            }
        }

        const missing = inputs
            .filter((inp) => inp.required)
            .filter((inp) => {
                const val = provided_inputs[inp.name];
                if (val === undefined || val === null) return true;
                /** Channel inputs are arrays — empty array = missing. */
                if (inp.type === 'channel') {
                    return !Array.isArray(val) || val.length === 0;
                }
                return typeof val === 'string' && !val.trim();
            })
            .map((inp) => inp.name);

        if (missing.length > 0) {
            throw ApiError.bad_request(
                `Required input${missing.length > 1 ? 's' : ''} missing: ${missing.join(', ')}`,
            );
        }
    }

    /**
     * Resolve a team from the Hub registry. Accepts:
     *   - "scope/name" string (e.g. "cliq/hello-world")
     *   - numeric Hub registry ID (as string)
     */
    private static async _resolve_hub_team(team_id: string): Promise<{ team: HubTeam; version: TeamVersion } | null> {
        let hub_team: HubTeam | null = null;

        if (team_id.includes('/')) {
            const [scope_slug, name] = team_id.split('/');
            hub_team = await HubTeam.findOne({ where: { scope: scope_slug, name } });
        }

        if (!hub_team && /^\d+$/.test(team_id)) {
            hub_team = await HubTeam.findByPk(Number(team_id));
        }

        if (!hub_team) return null;

        // Semver-sorted: highest version wins, not most-recently-published.
        // Fetching all rows and picking in Node keeps the semver logic in
        // one place (lib/semver.ts) — the version count per team is tiny
        // (unbounded but effectively O(10s)).
        const all_versions = await TeamVersion.findAll({
            where: { team_id: hub_team.id },
        });
        if (all_versions.length === 0) return null;
        const latest_version = sort_semver_desc(
            all_versions.map((v) => ({ version: v.version, row: v })),
        )[0].row;

        return { team: hub_team, version: latest_version };
    }

    private static async _resolve_install_targets(input: InstallTeamInput): Promise<Daemon[]> {
        if (input.daemon_ids && input.daemon_ids.length > 0) {
            const unique_ids = [...new Set(input.daemon_ids)];
            const daemons: Daemon[] = [];
            for (const daemon_id of unique_ids) {
                await AccessService.assert_realm_access(input.user_id, daemon_id);
                const pinned = await Daemon.findByPk(daemon_id);
                if (!pinned) {
                    throw ApiError.not_found(`Daemon '${daemon_id}' is not registered`);
                }
                daemons.push(pinned);
            }
            return daemons;
        }

        const ids = await RealmService.list_online_daemon_ids_in_realm(
            input.realm_id!,
            input.user_id,
        );
        if (ids.length === 0) return [];
        return Daemon.findAll({
            where: { id: { [Op.in]: ids }, status: 'online' },
            order: [['last_heartbeat', 'DESC']],
        });
    }


    /**
     * Mint (or reuse) the Hub teams row for a daemon install BEFORE
     * dispatching `/v1/install`. The Hub UUID is authoritative and is
     * sent to the daemon so local `teams.id` matches Hub.
     */
    private static async _ensure_daemon_team_row(input: {
        daemon_id: string;
        scope_slug: string;
        slug: string;
        version: string | null;
        description: string | null;
        manifest: string;
        dockerfile?: string | null;
        dependencies?: string | null;
        /** Prefer this id when claiming an existing unbound/same-daemon row. */
        preferred_id?: string;
    }): Promise<{ id: string }> {
        const scope = await Scope.findOne({ where: { slug: input.scope_slug } });
        if (!scope) {
            throw ApiError.not_found(`Scope '${input.scope_slug}' not found`);
        }

        const existing = await TeamService.find(scope.id, input.slug, {
            daemon_id: input.daemon_id,
        });
        if (existing) {
            await existing.update({
                version: input.version,
                description: input.description,
                manifest: input.manifest,
                dockerfile: input.dockerfile ?? existing.dockerfile,
                dependencies: input.dependencies ?? existing.dependencies,
                updated_at: Date.now(),
            });
            return { id: existing.id };
        }

        if (input.preferred_id) {
            const preferred = await Team.findByPk(input.preferred_id);
            if (
                preferred
                && preferred.scope_id === scope.id
                && preferred.slug === input.slug
                && (!preferred.daemon_id || preferred.daemon_id === input.daemon_id)
            ) {
                await preferred.update({
                    daemon_id: input.daemon_id,
                    version: input.version,
                    description: input.description,
                    manifest: input.manifest,
                    dockerfile: input.dockerfile ?? preferred.dockerfile,
                    dependencies: input.dependencies ?? preferred.dependencies,
                    updated_at: Date.now(),
                });
                return { id: preferred.id };
            }
        }

        const created = await TeamService.create(
            scope.id,
            input.slug,
            input.version,
            input.description,
            input.manifest,
            {
                daemon_id: input.daemon_id,
                dockerfile: input.dockerfile ?? null,
                dependencies: input.dependencies ?? null,
            },
        );
        return { id: created.id };
    }

    /**
     * Upsert the installed team into the core_api teams table for each
     * daemon that successfully installed it. This makes the team visible
     * in the daemon detail page without waiting for a daemon sync.
     * @deprecated Prefer `_ensure_daemon_team_row` before install.
     */
    private static async _upsert_installed_team(
        scope_slug: string,
        team_name: string,
        version: TeamVersion,
        hub_team: HubTeam,
        daemon_ids: string[],
    ): Promise<void> {
        for (const daemon_id of daemon_ids) {
            await DispatchService._ensure_daemon_team_row({
                daemon_id,
                scope_slug,
                slug: team_name,
                version: version.version,
                description: hub_team.description ?? null,
                manifest: version.workflow_json,
            });
        }
    }

    /**
     * Push updated agent settings to all online daemons in a realm.
     * Each key is written via the daemon's `/v1/settings/set` Message
     * envelope (daemon-scoped `agents.<name>.<key>`). `/v1/settings/pull`
     * is a different op (daemon pulls org defaults from Hub) and must
     * not be used for push.
     */
    static async push_agent_settings_to_realm(input: {
        realm_id: string;
        agent_name: string;
        settings: Record<string, string>;
        user_id: string;
    }): Promise<void> {
        const daemons = await DispatchService._get_online_daemons_for_realm(input.realm_id);
        if (daemons.length === 0) return;

        for (const daemon of daemons) {
            for (const [key, value] of Object.entries(input.settings)) {
                const setting_key = `agents.${input.agent_name}.${key}`;
                try {
                    await command_outbox_enqueue(daemon.id, '/v1/settings/set', {
                        version: 1,
                        id: randomUUID(),
                        timestamp: Date.now(),
                        run_id: null,
                        instance_id: null,
                        type: 'settings_set',
                        payload: {
                            workspace_dir: null,
                            key: setting_key,
                            value,
                        },
                    });
                } catch {
                    log.warn(`failed to enqueue settings push ${setting_key} to daemon ${daemon.id}`);
                }
            }
        }
    }

    private static async _get_online_daemons_for_realm(realm_id: string): Promise<Daemon[]> {
        const ids = await RealmMember.findAll({
            where: { realm_id, member_type: 'daemon' },
            attributes: ['member_id'],
            raw: true,
        });
        if (ids.length === 0) return [];
        const daemon_ids = ids.map((r) => r.member_id);
        return Daemon.findAll({
            where: { id: { [Op.in]: daemon_ids }, status: 'online' },
        });
    }

    /**
     * Remove realm_agent_settings rows for agents no longer used by any
     * team in the realm. Best-effort — called after team uninstall.
     */
    private static async _cleanup_orphaned_realm_settings(realm_id: string): Promise<void> {
        const realm = await Realm.findByPk(realm_id);
        const team_list = (realm as any)?.team_list ?? [];
        if (team_list.length === 0) {
            await RealmAgentSetting.destroy({ where: { realm_id } });
            return;
        }

        const settings_rows = await RealmAgentSetting.findAll({
            where: { realm_id },
            attributes: ['agent_name'],
            raw: true,
        });
        const configured_agents = new Set(settings_rows.map((r: any) => r.agent_name));
        if (configured_agents.size === 0) return;

        // Derive still-needed agents from Hub registry manifests
        const still_needed = new Set<string>();
        for (const entry of team_list) {
            const scope_slug = entry.scope.replace(/^@/, '');
            const hub_team = await HubTeam.findOne({
                where: { scope: scope_slug, name: entry.slug },
                attributes: ['id'],
            });
            if (!hub_team) continue;

            const latest_version = await TeamVersion.findOne({
                where: { team_id: hub_team.id },
                order: [['published_at', 'DESC']],
                attributes: ['workflow_json'],
            });
            if (!latest_version?.workflow_json) continue;

            try {
                const parsed = JSON.parse(latest_version.workflow_json);
                if (!Array.isArray(parsed?.phases)) continue;
                for (const phase of parsed.phases) {
                    if (phase.type === 'team') continue;
                    if (phase.agent) still_needed.add(phase.agent);
                }
            } catch { /* skip unparseable */ }
        }

        for (const agent_name of configured_agents) {
            if (still_needed.has(agent_name)) continue;
            await RealmAgentSetting.destroy({ where: { realm_id, agent_name } });
        }
    }

    /**
     * Parse a manifest JSON string and register any declared `events:` array
     * as custom event types in the discovery table. Best-effort / fire-and-forget.
     */
    private static async _register_manifest_events(
        manifest_json: string | null,
        realm_id: string | null,
        team_slug: string,
    ): Promise<void> {
        if (!manifest_json || !realm_id) return;

        try {
            const parsed = JSON.parse(manifest_json);
            const events: unknown = parsed?.events;
            if (!Array.isArray(events) || events.length === 0) return;

            const event_types = events.filter(
                (e): e is string => typeof e === 'string' && e.startsWith('custom.'),
            );
            if (event_types.length === 0) return;

            await CustomEventService.register_declared({ event_types, realm_id, team_slug });
        } catch {
            /* skip unparseable manifests */
        }
    }
}
