/**
 * Teams Hub resource — catalog CRUD + realm coverage + daemon inventory + fleet ops.
 *
 * Routes (1:1 with this controller):
 *   POST /v1/teams/get             — unified list (catalog | realm coverage | daemon inventory)
 *   POST /v1/teams/get_by_id       — single team detail
 *   POST /v1/teams/get_versions    — version history
 *   POST /v1/teams/get_phases      — workflow phases for a version
 *   POST /v1/teams/create          — create as draft
 *   POST /v1/teams/update          — update draft manifest / description
 *   POST /v1/teams/publish         — publish a version
 *   POST /v1/teams/unpublish       — revert to draft
 *   POST /v1/teams/download        — fetch package for a version
 *   POST /v1/teams/delete          — soft-delete team
 *   POST /v1/teams/delete_version  — remove specific version
 *   POST /v1/teams/rename          — rename within scope
 *   POST /v1/teams/build           — AI builder actions (generate/validate/suggest/chat)
 *   POST /v1/teams/install         — fan-out install (daemon_ids XOR realm_id)
 *   POST /v1/teams/uninstall       — fan-out uninstall (daemon_id/daemon_ids XOR realm_id)
 *
 * Response envelope: `{ ok: true, data: T }` via `this.ok()`.
 * List responses use `PagedData<TeamData>` — `{ items, total, offset, limit }`.
 * Inbound SoT: PascalCase Zod `Teams*Input` in `schemas/teams/types.ts`.
 */

import type { Request, Response } from 'express';
import { Op } from 'sequelize';

import { BaseController } from './base_controller.js';
import { ApiError } from '../lib/api_error.js';
import { ApiError as LegacyApiError } from '../errors/api_error.js';
import { DispatchService } from '../services/dispatch.service.js';
import { Team, Scope } from '../models/index.js';
import type { TeamsService } from '../services/teams_service.js';
import type { BuilderService } from '../services/builder_service.js';
import type { ApiOkResponse, ApiRequest, PagedData } from '../types/api_response.js';
import type { TeamData, TeamMutationData, TeamsGetVersionsData, TeamsGetPhasesData, TeamsInstallData, TeamsUninstallData } from '../schemas/team_types.js';
import {
    TeamsGetInput,
    TeamsGetByIdInput,
    TeamsGetVersionsInput,
    TeamsGetPhasesInput,
    TeamsCreateInput,
    TeamsUpdateInput,
    TeamsPublishInput,
    TeamsUnpublishInput,
    TeamsDownloadInput,
    TeamsDeleteTeamInput,
    TeamsDeleteVersionInput,
    TeamsRenameInput,
    TeamsInstallInput,
    TeamsUninstallInput,
} from '../schemas/team_types.js';
import { teams_build_schema } from '../schemas/builder_types.js';
import { to_team_list_item_dto } from '../types/mappers.js';

export class TeamsController extends BaseController {
    constructor(
        private readonly _teams_service: TeamsService,
        private readonly _builder_service?: BuilderService,
    ) {
        super();
    }

    // ─── Private helpers ────────────────────────────────────────────────────

    private _require_builder(): BuilderService {
        if (!this._builder_service) {
            throw ApiError.internal('Builder service not configured');
        }
        return this._builder_service;
    }

    /**
     * Delete `cliq.teams` rows for a scope/slug scoped to the target daemons.
     * Must be called before dispatching uninstall so re-install picks up fresh state.
     * No-op when the scope or realm resolves to zero daemons.
     */
    private async _purge_team_cache(
        scope_slug: string,
        team_slug: string,
        realm_id?: string,
        daemon_ids?: string[],
    ): Promise<void> {
        const scope_row = await Scope.findOne({ where: { slug: scope_slug }, attributes: ['id'] });
        if (!scope_row) return;

        const where: Record<string, unknown> = {
            scope_id: (scope_row as unknown as { id: string }).id,
            slug: team_slug,
        };

        if (daemon_ids && daemon_ids.length > 0) {
            where.daemon_id = { [Op.in]: daemon_ids };
        } else if (realm_id) {
            const { RealmService } = await import('../services/realm.service.js');
            const realm_daemon_ids = await RealmService.list_daemon_ids_in_realm(realm_id);
            if (realm_daemon_ids.length === 0) return;
            where.daemon_id = { [Op.in]: realm_daemon_ids };
        }

        await Team.destroy({ where });
    }

    // ─── Read handlers ───────────────────────────────────────────────────────

    /**
     * Unified team list. Mode is determined by filter params — all other params
     * apply as AND filters within the selected mode:
     * - `daemon_id`  → live installed teams from that daemon (proxied RPC)
     * - `realm_id`   → realm team roster with per-team daemon coverage
     * - neither      → Hub catalog search
     *
     * @param req - Body: {@link TeamsGetInput}
     * @param res - `{ ok: true, data: PagedData<TeamData> }`
     */
    async get(
        req: ApiRequest<TeamsGetInput, PagedData<TeamData>>,
        res: ApiOkResponse<PagedData<TeamData>>,
    ): Promise<void> {
        const body = this.parse_body(TeamsGetInput, req);
        const offset = body.offset ?? 0;
        const limit = body.limit ?? 50;

        // ── Daemon inventory mode ────────────────────────────────────────────
        if (body.daemon_id) {
            if (!req.auth?.user) throw ApiError.unauthorized('Authentication required');
            const { live_teams_from_daemon } = await import(
                '../services/daemon_live_inventory.service.js'
            );
            const result = await live_teams_from_daemon(
                body.daemon_id,
                String(req.auth?.user?.id ?? ''),
            );
            // The daemon RPC returns its own teams array — normalize to PagedData<TeamData>.
            const raw_teams: TeamData[] = (result as any)?.payload?.data?.teams ?? [];
            const q = body.query?.toLowerCase();
            const filtered = q
                ? raw_teams.filter((t) =>
                    (t.name ?? '').toLowerCase().includes(q) ||
                    (t.description ?? '').toLowerCase().includes(q),
                )
                : raw_teams;
            const page = filtered.slice(offset, offset + limit);
            this.ok(res, { items: page, total: filtered.length, offset, limit });
            return;
        }

        // ── Realm coverage mode ──────────────────────────────────────────────
        if (body.realm_id) {
            if (!req.auth?.user) throw ApiError.unauthorized('Authentication required');
            const { RealmService } = await import('../services/realm.service.js');
            const result = await RealmService.list_team_coverage(
                {
                    realm_id: body.realm_id,
                    query: body.query,
                    origin: body.origin,
                    coverage: body.coverage,
                    sort_by: body.sort_by,
                    sort_dir: body.sort_dir,
                    limit,
                    offset,
                },
                String(req.auth?.user?.id ?? ''),
            );
            // Map coverage rows to TeamData — coverage fields populated.
            const items: TeamData[] = result.rows.map((r) => ({
                name: r.slug,
                slug: r.slug,
                label: r.label,
                scope: null,
                version: r.version,
                origin: r.origin,
                in_team_list: r.in_team_list,
                installed_daemon_ids: r.installed_daemon_ids,
                installed_count: r.installed_count,
                online_daemon_count: result.online_daemon_count,
                coverage_label: r.coverage_label,
                missing_agents: r.missing_agents,
                last_run_at: r.last_run_at,
                sample_team_id: r.sample_team_id,
            }));
            this.ok(res, { items, total: result.total, offset, limit });
            return;
        }

        // ── Catalog search mode ──────────────────────────────────────────────
        const result = await this._teams_service.get(req.auth!, body);
        const r = result as any;

        if ('scopes' in r && r.tag_map) {
            const tag_map = r.tag_map as Map<string, string[]>;
            const all_teams: TeamData[] = (r.scopes as any[]).flatMap((sg) =>
                (sg.teams as any[]).map((t) => to_team_list_item_dto(t, tag_map.get(t.id) ?? []) as TeamData),
            );
            this.ok(res, { items: all_teams, total: all_teams.length, offset, limit });
            return;
        }

        if ('teams' in r && r.tag_map) {
            const tag_map = r.tag_map as Map<string, string[]>;
            const items: TeamData[] = (r.teams as any[]).map(
                (t) => to_team_list_item_dto(t, tag_map.get(t.id) ?? []) as TeamData,
            );
            this.ok(res, { items, total: r.total ?? items.length, offset, limit });
            return;
        }

        this.ok(res, { items: [], total: 0, offset, limit });
    }

    /**
     * Fetch one team by UUID or by name + scope.
     *
     * @param req - Body: {@link TeamsGetByIdInput}
     * @param res - `{ ok: true, data: TeamData }`
     */
    async get_by_id(
        req: ApiRequest<TeamsGetByIdInput, TeamData>,
        res: ApiOkResponse<TeamData>,
    ): Promise<void> {
        const body = this.parse_body(TeamsGetByIdInput, req);
        const result = await this._teams_service.get_by_id(req.auth!, body);
        this.ok(res, result as unknown as TeamData);
    }

    /**
     * Version history for a team. Pass `latest_only: true` to get a single
     * version string without the full list.
     *
     * @param req - Body: {@link TeamsGetVersionsInput}
     * @param res - `{ ok: true, data: TeamsGetVersionsData }`
     */
    async get_versions(
        req: ApiRequest<TeamsGetVersionsInput, TeamsGetVersionsData>,
        res: ApiOkResponse<TeamsGetVersionsData>,
    ): Promise<void> {
        const body = this.parse_body(TeamsGetVersionsInput, req);
        const result = await this._teams_service.get_versions(req.auth!, body);
        this.ok(res, result as TeamsGetVersionsData);
    }

    /**
     * Workflow phases for a published version. Omit `version_id` for latest.
     * Echoes the resolved `version_id` so callers can pin runs to a specific version.
     *
     * @param req - Body: {@link TeamsGetPhasesInput}
     * @param res - `{ ok: true, data: TeamsGetPhasesData }`
     */
    async get_phases(
        req: ApiRequest<TeamsGetPhasesInput, TeamsGetPhasesData>,
        res: ApiOkResponse<TeamsGetPhasesData>,
    ): Promise<void> {
        const body = this.parse_body(TeamsGetPhasesInput, req);
        const result = await this._teams_service.get_phases(req.auth!, body);
        this.ok(res, result as TeamsGetPhasesData);
    }

    // ─── Write handlers ──────────────────────────────────────────────────────

    /**
     * Create a team as draft. Seeds version 0.1.0 when a manifest is provided.
     * Name must match `^[a-z][a-z0-9-]*$` (validated in schema).
     *
     * @param req - Body: {@link TeamsCreateInput}
     * @param res - `{ ok: true, data: TeamMutationData }`
     */
    async create(
        req: ApiRequest<TeamsCreateInput, TeamMutationData>,
        res: ApiOkResponse<TeamMutationData>,
    ): Promise<void> {
        const body = this.parse_body(TeamsCreateInput, req);
        const result = await this._teams_service.create(req.auth!, body);
        this.ok(res, result as TeamMutationData);
    }

    /**
     * Update draft manifest / description. Auto patch-bumps semver;
     * pass `bump: minor|major` for larger increments.
     *
     * @param req - Body: {@link TeamsUpdateInput}
     * @param res - `{ ok: true, data: TeamMutationData }`
     */
    async update(
        req: ApiRequest<TeamsUpdateInput, TeamMutationData>,
        res: ApiOkResponse<TeamMutationData>,
    ): Promise<void> {
        const body = this.parse_body(TeamsUpdateInput, req);
        const result = await this._teams_service.update(req.auth!, body);
        this.ok(res, result as TeamMutationData);
    }

    /**
     * Publish a draft version. Returns HTTP 201 on first publish, 200 on overwrite.
     * `visibility` must be `public` or `private`; `draft` is rejected.
     *
     * @param req - Body: {@link TeamsPublishInput}
     * @param res - `{ ok: true, data: TeamMutationData }` — HTTP 201 create / 200 overwrite
     */
    async publish(
        req: ApiRequest<TeamsPublishInput, TeamMutationData>,
        res: ApiOkResponse<TeamMutationData>,
    ): Promise<void> {
        const body = this.parse_body(TeamsPublishInput, req);
        const result = await this._teams_service.publish(req.auth!, body);
        this.ok(res, result as TeamMutationData);
    }

    /**
     * Revert a published team to draft status. Versions are kept; only
     * `visibility` and `listed` are reset.
     *
     * @param req - Body: {@link TeamsUnpublishInput}
     * @param res - `{ ok: true, data: TeamMutationData }`
     */
    async unpublish(
        req: ApiRequest<TeamsUnpublishInput, TeamMutationData>,
        res: ApiOkResponse<TeamMutationData>,
    ): Promise<void> {
        const body = this.parse_body(TeamsUnpublishInput, req);
        const result = await this._teams_service.unpublish(req.auth!, body);
        this.ok(res, result as TeamMutationData);
    }

    /**
     * Fetch the package archive for a published version.
     *
     * @param req - Body: {@link TeamsDownloadInput}
     * @param res - `{ ok: true, data: unknown }` — package payload shape is version-dependent
     */
    async download(
        req: ApiRequest<TeamsDownloadInput, unknown>,
        res: ApiOkResponse<unknown>,
    ): Promise<void> {
        const body = this.parse_body(TeamsDownloadInput, req);
        const result = await this._teams_service.download(req.auth!, body);
        this.ok(res, result);
    }

    /**
     * Soft-delete a team and all its versions.
     *
     * @param req - Body: {@link TeamsDeleteTeamInput}
     * @param res - `{ ok: true, data: { deleted: boolean } }` — true if a row was removed
     */
    async delete_team(
        req: ApiRequest<TeamsDeleteTeamInput, { deleted: boolean }>,
        res: ApiOkResponse<{ deleted: boolean }>,
    ): Promise<void> {
        const body = this.parse_body(TeamsDeleteTeamInput, req);
        const result = await this._teams_service.delete_team(req.auth!, body);
        this.ok(res, result);
    }

    /**
     * Remove a specific published version. The team record is kept.
     *
     * @param req - Body: {@link TeamsDeleteVersionInput}
     * @param res - `{ ok: true, data: { deleted: boolean, version: string } }` — echoes removed version
     */
    async delete_version(
        req: ApiRequest<TeamsDeleteVersionInput, { deleted: boolean; version: string }>,
        res: ApiOkResponse<{ deleted: boolean; version: string }>,
    ): Promise<void> {
        const body = this.parse_body(TeamsDeleteVersionInput, req);
        const result = await this._teams_service.delete_version(req.auth!, body);
        this.ok(res, result);
    }

    /**
     * Rename a team within its scope. The old name is freed immediately.
     *
     * @param req - Body: {@link TeamsRenameInput}
     * @param res - `{ ok: true, data: TeamMutationData }`
     */
    async rename(
        req: ApiRequest<TeamsRenameInput, TeamMutationData>,
        res: ApiOkResponse<TeamMutationData>,
    ): Promise<void> {
        const body = this.parse_body(TeamsRenameInput, req);
        const result = await this._teams_service.rename_team(req.auth!, body);
        this.ok(res, result as TeamMutationData);
    }

    // ─── Builder ─────────────────────────────────────────────────────────────

    /**
     * AI builder actions dispatched by `action` field.
     * Actions: `generate` | `status` | `improve_role` | `suggest` | `validate` | `chat`.
     *
     * @param req - Body: {@link teams_build_schema}
     * @param res - `{ ok: true, data: unknown }` — shape varies by action
     */
    async build(
        req: ApiRequest<typeof teams_build_schema._type, unknown>,
        res: ApiOkResponse<unknown>,
    ): Promise<void> {
        const body = this.parse_body(teams_build_schema, req);
        const builder = this._require_builder();

        switch (body.action) {
            case 'generate': {
                if (!body.intent?.trim()) {
                    throw new LegacyApiError('invalid_params', 'intent is required for generate action', 422);
                }
                this.ok(res, builder.start_generate(req.auth!, { intent: body.intent! }));
                return;
            }
            case 'status': {
                if (!body.job_id) {
                    throw new LegacyApiError('invalid_params', 'job_id is required for status action', 422);
                }
                this.ok(res, builder.get_generate_job(body.job_id!));
                return;
            }
            case 'improve_role': {
                if (!body.role_name || !body.role_content) {
                    throw new LegacyApiError('invalid_params', 'role_name and role_content are required for improve_role action', 422);
                }
                this.ok(res, await builder.improve_role(req.auth!, {
                    role_name: body.role_name!,
                    role_content: body.role_content!,
                    team_name: body.team_name ?? '',
                    team_description: body.team_description ?? '',
                    phases: (body.phases as string[] | undefined) ?? [],
                    instruction: body.instruction,
                }));
                return;
            }
            case 'suggest': {
                if (!body.team_name) {
                    throw new LegacyApiError('invalid_params', 'team_name is required for suggest action', 422);
                }
                this.ok(res, await builder.suggest(req.auth!, {
                    team_name: body.team_name!,
                    description: body.description ?? '',
                    phases: body.phases ?? [],
                    roles: body.roles ?? [],
                }));
                return;
            }
            case 'validate': {
                if (!body.team) {
                    throw new LegacyApiError('invalid_params', 'team is required for validate action', 422);
                }
                this.ok(res, builder.validate(req.auth!, { team: body.team }));
                return;
            }
            case 'chat': {
                if (!body.message || !body.team) {
                    throw new LegacyApiError('invalid_params', 'message and team are required for chat action', 422);
                }
                this.ok(res, await builder.chat(req.auth!, {
                    team: body.team,
                    message: body.message!,
                    history: body.history,
                }));
                return;
            }
        }
    }

    // ─── Fleet install / uninstall ────────────────────────────────────────────

    /**
     * Fan-out install to daemon_ids XOR every daemon in realm_id.
     * Enqueues via outbox — returns the queued item and per-daemon results,
     * not a final completion status.
     *
     * @param req - Body: {@link TeamsInstallInput}
     * @param res - `{ ok: true, data: TeamsInstallData }`
     */
    async install(
        req: ApiRequest<TeamsInstallInput, TeamsInstallData>,
        res: ApiOkResponse<TeamsInstallData>,
    ): Promise<void> {
        const body = this.parse_body(TeamsInstallInput, req);
        const auth = this.auth_from(req);
        const result = await DispatchService.install_via_queue({
            team_id: body.team_id,
            daemon_ids: body.daemon_ids,
            realm_id: body.realm_id,
            agent_settings: body.agent_settings,
            force: body.force,
            version: body.version,
            user_id: String(auth?.user?.id ?? ''),
            org_ids: auth?.org_ids ?? [],
        });
        this.ok(res, result);
    }

    /**
     * Purge Hub team cache then fan-out uninstall from daemon_id/daemon_ids XOR realm_id.
     * Idempotent: dispatches even when the team is no longer locally installed.
     * Cache must be purged before dispatch so a subsequent install picks up fresh state.
     *
     * @param req - Body: {@link TeamsUninstallInput}
     * @param res - `{ ok: true, data: TeamsUninstallData }`
     */
    async uninstall(
        req: ApiRequest<TeamsUninstallInput, TeamsUninstallData>,
        res: ApiOkResponse<TeamsUninstallData>,
    ): Promise<void> {
        const body = this.parse_body(TeamsUninstallInput, req);
        const daemon_ids = [
            ...(body.daemon_id ? [body.daemon_id] : []),
            ...(body.daemon_ids ?? []),
        ];

        // Purge cached rows before dispatch so re-install sees fresh state.
        await this._purge_team_cache(body.scope, body.slug, body.realm_id, daemon_ids);

        const auth = this.auth_from(req);
        const result = await DispatchService.uninstall_via_queue({
            scope: body.scope,
            slug: body.slug,
            realm_id: body.realm_id,
            daemon_ids: daemon_ids.length > 0 ? daemon_ids : undefined,
            user_id: String(auth?.user?.id ?? ''),
            org_ids: auth?.org_ids ?? [],
        });

        this.ok(res, {
            ...result,
            // Convenience flag — true when at least one daemon acknowledged the uninstall.
            dispatched: result.results.some((r) => r.ok),
        });
    }
}
