import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';

import { get_logger } from '../lib/log.js';
import type { Scope } from '../models/scope.model.js';
import type { DaemonTeam } from '../models/daemon_team.model.js';
import { DaemonTeamRepository } from '../repositories/daemon_team_repository.js';
import { WorkspaceTeamRepository } from '../repositories/workspace_team_repository.js';
import { RunRepository } from '../repositories/run_repository.js';
import { ScopeRepository } from '../repositories/scope_repository.js';

const log = get_logger('svc.teams_install');

const _dt_repo_ti = new DaemonTeamRepository();
const _wst_repo_ti = new WorkspaceTeamRepository();
const _run_repo_ti = new RunRepository();
const _scope_repo_ti = new ScopeRepository();
import { ApiError } from '../lib/api_error.js';
import { get_sequelize } from '../lib/sequelize.js';


/**
 * Payload from daemon `/v1/teams/upsert`. The daemon knows its local
 * scope by slug, not Hub's `scope_id`, so `scope_slug` is the required
 * key and `scope_id` is optional (older callers). Missing scopes are
 * auto-created — the daemon has already validated the install locally,
 * so refusing here would just make Hub the bottleneck.
 */
export type TeamUpsertFromDaemonPayload = {
    id: string;
    scope_slug: string;
    slug: string;
    version: string | null;
    description: string | null;
    manifest: string;
    dockerfile: string | null;
    dependencies: string | null;
    daemon_id: string | null;
};

export type TeamRemoveFromDaemonPayload = {
    team_id?: string;
    scope_slug: string;
    slug: string;
    daemon_id: string | null;
};


export class TeamService {

    /**
     * List teams.
     *
     * @param scope_ids  Optional scope filter (single id or array).
     * @param filter     `daemon_id` restricts to teams owned by that
     *                   daemon (default per-daemon view). If omitted,
     *                   returns every row across daemons (the --global
     *                   / cross-daemon view). Legacy rows with
     *                   `daemon_id IS NULL` show up under the global
     *                   view only, and are invisible to per-daemon
     *                   queries until backfilled.
     */
    static async list(
        scope_ids?: string | string[],
        filter: { daemon_id?: string } = {},
    ) {
        log.debug('list', { daemon_id: filter.daemon_id });
        const where: Record<string, unknown> = {};
        if (scope_ids) {
            const ids = Array.isArray(scope_ids) ? scope_ids : [scope_ids];
            if (ids.length > 0) {
                where.scope_id = { [Op.in]: ids };
            }
        }
        if (filter.daemon_id) {
            where.daemon_id = filter.daemon_id;
        }

        const teams = await _dt_repo_ti.find_all_q({
            where,
            order: [['slug', 'ASC']],
        });

        const team_scope_ids = [...new Set(teams.map(t => t.scope_id).filter(Boolean))];
        const scopes = team_scope_ids.length === 0
            ? []
            : await _scope_repo_ti.find_all_q({ where: { id: { [Op.in]: team_scope_ids } }, attributes: ['id', 'slug'] });
        const scope_slug_by_id = new Map(scopes.map(s => [s.id, s.slug]));

        const team_ids = teams.map(t => t.id);
        if (team_ids.length === 0) return [];

        const [ws_counts, active_counts] = await Promise.all([
            _wst_repo_ti.find_all_q({
                where: { team_id: { [Op.in]: team_ids } },
                attributes: ['team_id'],
            }),
            _run_repo_ti.find_all_q({
                where: { team_id: { [Op.in]: team_ids }, state: { [Op.in]: ['running', 'awaiting_input'] } },
                attributes: ['team_id'],
            }),
        ]);

        const ws_map = new Map<string, number>();
        for (const wt of ws_counts) {
            ws_map.set(wt.get('team_id') as string, (ws_map.get(wt.get('team_id') as string) ?? 0) + 1);
        }
        const run_map = new Map<string, number>();
        for (const r of active_counts) {
            run_map.set(r.team_id, (run_map.get(r.team_id) ?? 0) + 1);
        }

        return teams.map(t => {
            const plain = t.toJSON() as any;
            return {
                ...plain,
                scope: scope_slug_by_id.get(t.scope_id) ?? 'default',
                workspace_count: ws_map.get(t.id) ?? 0,
                active_run_count: run_map.get(t.id) ?? 0,
            };
        });
    }

    static async get(scope_id: string, slug: string) {
        log.debug('get', { scope_id, slug });
        const team = await _dt_repo_ti.find_one_q({ where: { scope_id, slug } });
        if (!team) throw ApiError.not_found(`team '${slug}' not found in scope '${scope_id}'`);
        return team;
    }

    /**
     * Return the team row for (scope, slug) — Design Z aware — or null
     * if it doesn't exist. When `daemon_id` is passed, the lookup is
     * scoped to that daemon; otherwise the first matching row across
     * daemons is returned. Used by the wire endpoint that historically
     * threw 404 on miss, which broke the "does this daemon have it?"
     * duplicate-check pattern.
     */
    static async find(scope_id: string, slug: string, opts: { daemon_id?: string } = {}) {
        log.debug('find', { scope_id, slug, daemon_id: opts.daemon_id });
        const where: Record<string, unknown> = { scope_id, slug };
        if (opts.daemon_id) {
            where.daemon_id = opts.daemon_id;
        }
        return _dt_repo_ti.find_one_q({ where });
    }

    static async get_by_id(id: string) {
        log.debug('get_by_id', { id });
        const team = await _dt_repo_ti.find_by_id(id);
        if (!team) throw ApiError.not_found(`team '${id}' not found`);
        return team;
    }

    static async create(
        scope_id: string,
        slug: string,
        version: string | null,
        description: string | null,
        manifest: string,
        deps?: {
            dockerfile?: string | null;
            dependencies?: string | null;
            /**
             * Daemon that owns this installation (Design Z). Required
             * for new writes; the CLI reads the current daemon id from
             * `~/.cliqrc/settings.json` and threads it through.
             */
            daemon_id?: string | null;
            /** Hub-minted PK — must match the id installed on the daemon. */
            id?: string;
        },
    ) {
        log.debug('create', { scope_id, slug, daemon_id: deps?.daemon_id });
        const now = Date.now();
        return _dt_repo_ti.create_one({
            id: deps?.id?.trim() || randomUUID(),
            daemon_id: deps?.daemon_id ?? null,
            scope_id,
            slug,
            version: version ?? null,
            description: description ?? null,
            manifest,
            dockerfile: deps?.dockerfile ?? null,
            dependencies: deps?.dependencies ?? null,
            created_at: now,
            updated_at: now,
        });
    }

    static async update(
        scope_id: string,
        slug: string,
        data: {
            manifest?: string;
            version?: string | null;
            description?: string | null;
            dockerfile?: string | null;
            dependencies?: string | null;
        },
    ) {
        log.debug('update', { scope_id, slug });
        const team = await TeamService.get(scope_id, slug);
        return team.update({ ...data, updated_at: Date.now() });
    }

    static async remove(scope_id: string, slug: string) {
        log.debug('remove', { scope_id, slug });
        const team = await _dt_repo_ti.find_one_q({ where: { scope_id, slug } });
        if (!team) return false;

        const team_id = team.get('id') as string;
        const sequelize = get_sequelize();
        const tx = await sequelize.transaction();

        try {
            await _wst_repo_ti.delete_where_q({ where: { team_id }, transaction: tx } as any);
            await _run_repo_ti.delete_where_q({ where: { team_id }, transaction: tx } as any);
            await team.destroy({ transaction: tx });
            await tx.commit();
            return true;
        } catch (err) {
            await tx.rollback();
            throw err;
        }
    }

    static async count_by_scope(scope_id: string): Promise<number> {
        return _dt_repo_ti.find_count({ scope_id } as any);
    }

    /**
     * Resolve scope by slug, auto-creating if missing.
     *
     * The daemon has already authorized the install locally (either via
     * Hub login for scoped installs, or offline for `default`/`local`).
     * If we hit an unknown scope here it means the daemon-side scope row
     * exists but the Hub row was never seeded, or the scope was created
     * during boot before Hub sync came online. Auto-create keeps the
     * two catalogs in step without a separate scope-sync round trip.
     */
    private static async _resolve_scope_by_slug(scope_slug: string): Promise<Scope> {
        let scope = await _scope_repo_ti.find_one_q({ where: { slug: scope_slug } });
        if (scope) return scope;

        scope = await _scope_repo_ti.create_one({
            id: randomUUID(),
            slug: scope_slug,
            display_name: scope_slug === 'cliq' ? 'Cliq' : scope_slug,
            owner_id: null,
            org_id: null,
            scope_type: 'platform',
            visibility: 'public',
            is_default: 0,
        });
        return scope;
    }

    /**
     * Idempotent team upsert driven by the daemon outbox.
     *
     * First checks for an existing row by `(daemon_id, scope_id, slug)`,
     * which may have been Hub-minted by `DispatchService.install_team`
     * with a different PK. If found, updates in place to avoid a unique
     * index conflict on `teams_daemon_scope_slug_uniq`. Falls back to
     * PK-based upsert for the common case where daemon minted the row.
     */
    static async upsert_from_daemon(
        payload: TeamUpsertFromDaemonPayload,
    ): Promise<{ team: DaemonTeam; created: boolean }> {
        log.debug('upsert_from_daemon', { scope_slug: payload.scope_slug, slug: payload.slug, daemon_id: payload.daemon_id });
        const scope = await TeamService._resolve_scope_by_slug(payload.scope_slug);
        const now = Date.now();

        /** Check for an existing row by natural key (daemon + scope + slug). */
        if (payload.daemon_id) {
            const by_natural_key = await _dt_repo_ti.find_one_q({
                where: {
                    daemon_id: payload.daemon_id,
                    scope_id: scope.id,
                    slug: payload.slug,
                },
            });

            if (by_natural_key) {
                await by_natural_key.update({
                    version: payload.version,
                    description: payload.description,
                    manifest: payload.manifest,
                    dockerfile: payload.dockerfile ?? by_natural_key.dockerfile,
                    dependencies: payload.dependencies ?? by_natural_key.dependencies,
                    updated_at: now,
                });
                return { team: by_natural_key, created: false };
            }
        }

        /** No existing row by natural key — PK-based upsert (daemon-minted id). */
        const existing = await _dt_repo_ti.find_by_id(payload.id);
        const [team, created] = await _dt_repo_ti.upsert_one({
            id: payload.id,
            daemon_id: payload.daemon_id ?? null,
            scope_id: scope.id,
            slug: payload.slug,
            version: payload.version,
            description: payload.description,
            manifest: payload.manifest,
            dockerfile: payload.dockerfile,
            dependencies: payload.dependencies,
            created_at: existing?.get('created_at') as number | undefined ?? now,
            updated_at: now,
        });
        if (created ?? !existing) {
            log.info('team_upserted_from_daemon', { team_id: team.id, scope_slug: payload.scope_slug, slug: payload.slug });
        }
        return { team, created: created ?? !existing };
    }

    /**
     * Idempotent remove driven by the daemon outbox. Accepts either the
     * concrete team_id or the (scope_slug, slug) pair — daemon sends
     * both so Hub can locate the row even if the id mapping drifted.
     */
    static async remove_from_daemon(payload: TeamRemoveFromDaemonPayload): Promise<boolean> {
        log.debug('remove_from_daemon', { scope_slug: payload.scope_slug, slug: payload.slug, team_id: payload.team_id });
        let team: DaemonTeam | null = null;
        if (payload.team_id) {
            team = await _dt_repo_ti.find_by_id(payload.team_id);
        }
        if (!team) {
            const scope = await _scope_repo_ti.find_one_q({ where: { slug: payload.scope_slug } });
            if (!scope) return false;
            team = await _dt_repo_ti.find_one_q({ where: { scope_id: scope.id, slug: payload.slug } });
        }
        if (!team) return false;

        const team_id = team.get('id') as string;
        const sequelize = get_sequelize();
        const tx = await sequelize.transaction();
        try {
            await _wst_repo_ti.delete_where_q({ where: { team_id }, transaction: tx } as any);
            await _run_repo_ti.delete_where_q({ where: { team_id }, transaction: tx } as any);
            await team.destroy({ transaction: tx });
            await tx.commit();
            return true;
        } catch (err) {
            await tx.rollback();
            throw err;
        }
    }
}
