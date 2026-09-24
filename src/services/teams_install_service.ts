import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';

import { Team, WorkspaceTeam, Run, Scope } from '../models/index.js';
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

        const teams = await Team.findAll({
            where,
            include: [{ model: Scope, as: 'scope', attributes: ['slug'] }],
            order: [['slug', 'ASC']],
        });

        const team_ids = teams.map(t => t.id);
        if (team_ids.length === 0) return [];

        const [ws_counts, active_counts] = await Promise.all([
            WorkspaceTeam.findAll({
                where: { team_id: { [Op.in]: team_ids } },
                attributes: ['team_id'],
            }),
            Run.findAll({
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
                scope: plain.scope?.slug ?? 'default',
                workspace_count: ws_map.get(t.id) ?? 0,
                active_run_count: run_map.get(t.id) ?? 0,
            };
        });
    }

    static async get(scope_id: string, slug: string) {
        const team = await Team.findOne({ where: { scope_id, slug } });
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
        const where: Record<string, unknown> = { scope_id, slug };
        if (opts.daemon_id) {
            where.daemon_id = opts.daemon_id;
        }
        return Team.findOne({ where });
    }

    static async get_by_id(id: string) {
        const team = await Team.findByPk(id);
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
        const now = Date.now();
        return Team.create({
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
        const team = await TeamService.get(scope_id, slug);
        return team.update({ ...data, updated_at: Date.now() });
    }

    static async remove(scope_id: string, slug: string) {
        const team = await Team.findOne({ where: { scope_id, slug } });
        if (!team) return false;

        const team_id = team.get('id') as string;
        const sequelize = get_sequelize();
        const tx = await sequelize.transaction();

        try {
            await WorkspaceTeam.destroy({ where: { team_id }, transaction: tx });
            await Run.destroy({ where: { team_id }, transaction: tx });
            await team.destroy({ transaction: tx });
            await tx.commit();
            return true;
        } catch (err) {
            await tx.rollback();
            throw err;
        }
    }

    static async count_by_scope(scope_id: string): Promise<number> {
        return Team.count({ where: { scope_id } });
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
        let scope = await Scope.findOne({ where: { slug: scope_slug } });
        if (scope) return scope;

        scope = await Scope.create({
            id: randomUUID(),
            slug: scope_slug,
            name: scope_slug === 'cliq' ? 'Cliq' : scope_slug,
            org_id: null,
            scope_type: null,
            is_default: 0,
            created_at: Date.now(),
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
    ): Promise<{ team: Team; created: boolean }> {
        const scope = await TeamService._resolve_scope_by_slug(payload.scope_slug);
        const now = Date.now();

        /** Check for an existing row by natural key (daemon + scope + slug). */
        if (payload.daemon_id) {
            const by_natural_key = await Team.findOne({
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
        const existing = await Team.findByPk(payload.id);
        const [team, created] = await Team.upsert({
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
        return { team, created: created ?? !existing };
    }

    /**
     * Idempotent remove driven by the daemon outbox. Accepts either the
     * concrete team_id or the (scope_slug, slug) pair — daemon sends
     * both so Hub can locate the row even if the id mapping drifted.
     */
    static async remove_from_daemon(payload: TeamRemoveFromDaemonPayload): Promise<boolean> {
        let team: Team | null = null;
        if (payload.team_id) {
            team = await Team.findByPk(payload.team_id);
        }
        if (!team) {
            const scope = await Scope.findOne({ where: { slug: payload.scope_slug } });
            if (!scope) return false;
            team = await Team.findOne({ where: { scope_id: scope.id, slug: payload.slug } });
        }
        if (!team) return false;

        const team_id = team.get('id') as string;
        const sequelize = get_sequelize();
        const tx = await sequelize.transaction();
        try {
            await WorkspaceTeam.destroy({ where: { team_id }, transaction: tx });
            await Run.destroy({ where: { team_id }, transaction: tx });
            await team.destroy({ transaction: tx });
            await tx.commit();
            return true;
        } catch (err) {
            await tx.rollback();
            throw err;
        }
    }
}
