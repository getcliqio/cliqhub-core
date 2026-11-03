import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';

import { get_logger } from '../lib/log.js';
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

    /**
     * The one rule for a daemon's install slot (PLAN-team-bundle S4.2): one row per (daemon, catalog team) for
     * life, written only when the hub installs a realm team onto the daemon. An existing row (installed or not)
     * is reactivated and keeps its id, now pointing at this realm team and version; otherwise a row is created
     * with a fresh id. Core never takes an id from a daemon.
     *
     * @returns the row id: what the daemon keeps (cliqd's `hub_team_id`) and its runs carry.
     */
    static async install_slot(input: {
        daemon_id: string;
        /** The realm team being installed (from `RealmTeamListService`). */
        realm_team: { id: string; team_id: string; version_id: string; version: string };
        scope_id: string;
        slug: string;
        description: string | null;
        manifest: string;
        dockerfile?: string | null;
        dependencies?: string | null;
    }): Promise<{ id: string; created: boolean }> {
        const now = Date.now();
        const { realm_team } = input;
        const fields = {
            team_id: realm_team.team_id,
            realm_team_id: realm_team.id,
            version_id: realm_team.version_id,
            version: realm_team.version,
            scope_id: input.scope_id,
            slug: input.slug,
            origin: 'hub',
            description: input.description,
            manifest: input.manifest,
            uninstalled_at: null,
            updated_at: now,
        };
        // The installed row first, else the most recent uninstalled one: a reinstall gets its id back.
        const slot = await _dt_repo_ti.find_one_any({
            where: { daemon_id: input.daemon_id, team_id: realm_team.team_id },
            order: [[get_sequelize().literal('"uninstalled_at" IS NULL'), 'DESC'], ['updated_at', 'DESC']],
        });
        if (slot) {
            await slot.update({
                ...fields,
                dockerfile: input.dockerfile ?? slot.dockerfile,
                dependencies: input.dependencies ?? slot.dependencies,
            } as any);
            return { id: slot.id, created: false };
        }
        const id = randomUUID();
        await _dt_repo_ti.create_one({
            id,
            daemon_id: input.daemon_id,
            ...fields,
            dockerfile: input.dockerfile ?? null,
            dependencies: input.dependencies ?? null,
            created_at: now,
        } as any);
        return { id, created: true };
    }

    /**
     * `daemons/register_teams` (PLAN-team-bundle S4.2): the daemon reports the teams it has by the id the hub gave
     * it (the row id). A team is kept only when the hub installed it on this daemon and its catalog team is on the
     * daemon's realm (`realm_teams`); its version is updated to what the daemon has. Anything else gets no id:
     * `unknown` (not a team the hub installed here — a local or CLI install stays in cliqd) or `not_in_realm` (the
     * team is no longer on the realm: the row is marked uninstalled). With `complete`, the list is the daemon's
     * whole roster: its other installed rows are marked uninstalled.
     */
    static async register_from_daemon(
        daemon_id: string,
        teams: ReadonlyArray<{
            id?: string | null;
            scope: string;
            slug: string;
            version?: string | null;
            description?: string | null;
            manifest?: string | null;
            dockerfile?: string | null;
            dependencies?: string | null;
        }>,
        complete: boolean,
        /** The daemon's realm teams, by catalog team id. */
        realm_teams: ReadonlyMap<string, { id: string; team_id: string; version_id: string; version: string }>,
    ): Promise<Array<{ scope: string; slug: string; id: string | null; error?: string; reason?: 'not_in_realm' | 'unknown' }>> {
        const out: Array<{ scope: string; slug: string; id: string | null; error?: string; reason?: 'not_in_realm' | 'unknown' }> = [];
        const kept = new Set<string>();
        for (const t of teams) {
            const label = `@${t.scope}/${t.slug}`;
            const row = t.id ? await _dt_repo_ti.find_by_id_any(t.id) : null;
            if (!row || row.daemon_id !== daemon_id || !row.team_id) {
                out.push({ scope: t.scope, slug: t.slug, id: null, reason: 'unknown', error: `${label} wasn't installed on this daemon by the hub. Add it to the realm to install it.` });
                continue;
            }
            const realm_team = realm_teams.get(row.team_id);
            if (!realm_team) {
                if (row.uninstalled_at == null) await TeamService._mark_uninstalled(row);
                out.push({ scope: t.scope, slug: t.slug, id: null, reason: 'not_in_realm', error: `${label} isn't in this daemon's realm` });
                continue;
            }
            const version = t.version ?? row.version;
            const version_id = version === realm_team.version
                ? realm_team.version_id
                : version === row.version ? row.version_id : await TeamService._version_id(row.team_id, version);
            await row.update({
                realm_team_id: realm_team.id,
                version,
                version_id,
                ...(t.description !== undefined ? { description: t.description } : {}),
                ...(t.manifest ? { manifest: t.manifest } : {}),
                ...(t.dockerfile ? { dockerfile: t.dockerfile } : {}),
                ...(t.dependencies ? { dependencies: t.dependencies } : {}),
                uninstalled_at: null,
                updated_at: Date.now(),
            } as any);
            kept.add(row.id);
            out.push({ scope: t.scope, slug: t.slug, id: row.id });
        }

        if (complete) {
            const installed = await _dt_repo_ti.find_all_q({ where: { daemon_id } });
            for (const row of installed) {
                if (!kept.has(row.id)) await TeamService._mark_uninstalled(row);
            }
        }
        return out;
    }

    /** A catalog version's id by its number (published), or null. */
    private static async _version_id(team_id: string, version: string | null): Promise<string | null> {
        if (!version) return null;
        const { TeamVersionRepository } = await import('../repositories/team_version_repository.js');
        return (await new TeamVersionRepository().find_by_team_and_version(team_id, version))?.id ?? null;
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

        return TeamService._mark_uninstalled(team);
    }

    static async count_by_scope(scope_id: string): Promise<number> {
        return _dt_repo_ti.find_count({ scope_id } as any);
    }

    /**
     * Uninstall a slot: drop its workspace links and mark it uninstalled. The
     * row and its runs stay — runs keep their team, a reinstall keeps the id.
     */
    private static async _mark_uninstalled(team: DaemonTeam): Promise<boolean> {
        const team_id = team.get('id') as string;
        const sequelize = get_sequelize();
        const tx = await sequelize.transaction();
        try {
            await _wst_repo_ti.delete_where_q({ where: { team_id }, transaction: tx } as any);
            const now = Date.now();
            await team.update({ uninstalled_at: now, updated_at: now }, { transaction: tx });
            await tx.commit();
            return true;
        } catch (err) {
            await tx.rollback();
            throw err;
        }
    }
}
