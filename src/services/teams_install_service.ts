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
     * The one rule for a daemon's install slot (daemon, scope, slug): a slot
     * keeps its id for life. An existing slot (installed or uninstalled) is
     * reactivated and keeps its id; if the daemon proposed a different id, this
     * daemon's runs carrying it are moved to the slot. A new slot takes the
     * proposed id when free, else a fresh one.
     *
     * @returns the slot id the daemon must use.
     */
    static async settle_slot(input: {
        daemon_id: string;
        scope_id: string;
        slug: string;
        /** The id the daemon has (or would like) for this team. */
        proposed_id?: string | null;
        version: string | null;
        description: string | null;
        manifest: string;
        dockerfile?: string | null;
        dependencies?: string | null;
    }): Promise<{ id: string; created: boolean; moved_runs: number }> {
        const now = Date.now();
        const proposed = input.proposed_id?.trim() || null;
        const slot = await _dt_repo_ti.find_one_any({
            where: { daemon_id: input.daemon_id, scope_id: input.scope_id, slug: input.slug },
        });
        if (slot) {
            await slot.update({
                version: input.version,
                description: input.description,
                manifest: input.manifest,
                dockerfile: input.dockerfile ?? slot.dockerfile,
                dependencies: input.dependencies ?? slot.dependencies,
                uninstalled_at: null,
                updated_at: now,
            });
            let moved_runs = 0;
            if (proposed && proposed !== slot.id) {
                [moved_runs] = await _run_repo_ti.update_where(
                    { daemon_id: input.daemon_id, team_id: proposed } as any,
                    { team_id: slot.id } as any,
                );
                log.info('daemon_team_id_settled', {
                    daemon_id: input.daemon_id, slug: input.slug, slot_id: slot.id, daemon_had: proposed, moved_runs,
                });
            }
            return { id: slot.id, created: false, moved_runs };
        }

        // A proposed id already used by another slot can't be reused — except an
        // installed, not-yet-bound row of this very team (an explicit install of
        // that row): the daemon takes it over and its id. Detached leftovers are
        // uninstalled and never taken over.
        const taken = proposed ? await _dt_repo_ti.find_by_id_any(proposed) : null;
        if (
            taken
            && !taken.daemon_id
            && taken.uninstalled_at == null
            && taken.scope_id === input.scope_id
            && taken.slug === input.slug
        ) {
            await taken.update({
                daemon_id: input.daemon_id,
                version: input.version,
                description: input.description,
                manifest: input.manifest,
                dockerfile: input.dockerfile ?? taken.dockerfile,
                dependencies: input.dependencies ?? taken.dependencies,
                updated_at: now,
            });
            return { id: taken.id, created: false, moved_runs: 0 };
        }
        const id = proposed && !taken ? proposed : randomUUID();
        const row = await _dt_repo_ti.create_one({
            id,
            daemon_id: input.daemon_id,
            scope_id: input.scope_id,
            slug: input.slug,
            version: input.version,
            description: input.description,
            manifest: input.manifest,
            dockerfile: input.dockerfile ?? null,
            dependencies: input.dependencies ?? null,
            uninstalled_at: null,
            created_at: now,
            updated_at: now,
        } as any);
        return { id: String(row.id ?? id), created: true, moved_runs: 0 };
    }

    /**
     * `daemons/register_teams`: settle each team the daemon reports and return
     * the id it must use. With `complete`, the list is the daemon's whole
     * roster: its other installed slots are marked uninstalled. Scopes are
     * looked up, never created — an unknown scope comes back as an error.
     * With `realm_teams` (the daemon's realm team list, `scope/slug`), a team
     * not on it is refused (`reason: not_in_realm`) and gets no slot.
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
        realm_teams: ReadonlySet<string> | null = null,
    ): Promise<Array<{ scope: string; slug: string; id: string | null; error?: string; reason?: 'not_in_realm' | 'unknown_scope' }>> {
        const scope_slugs = [...new Set(teams.map((t) => t.scope))];
        const scopes = scope_slugs.length
            ? await _scope_repo_ti.find_all_q({ where: { slug: { [Op.in]: scope_slugs } } })
            : [];
        const scope_id_by_slug = new Map(scopes.map((sc) => [sc.slug, String(sc.id)]));

        const out: Array<{ scope: string; slug: string; id: string | null; error?: string; reason?: 'not_in_realm' | 'unknown_scope' }> = [];
        const kept = new Set<string>();
        for (const t of teams) {
            const scope_id = scope_id_by_slug.get(t.scope);
            if (!scope_id) {
                out.push({ scope: t.scope, slug: t.slug, id: null, error: `Unknown scope '${t.scope}'`, reason: 'unknown_scope' });
                continue;
            }
            if (realm_teams && !realm_teams.has(`${t.scope}/${t.slug}`)) {
                out.push({ scope: t.scope, slug: t.slug, id: null, error: `@${t.scope}/${t.slug} isn't in this daemon's realm`, reason: 'not_in_realm' });
                continue;
            }
            const settled = await TeamService.settle_slot({
                daemon_id,
                scope_id,
                slug: t.slug,
                proposed_id: t.id ?? null,
                version: t.version ?? null,
                description: t.description ?? null,
                manifest: t.manifest ?? '',
                dockerfile: t.dockerfile ?? null,
                dependencies: t.dependencies ?? null,
            });
            kept.add(settled.id);
            out.push({ scope: t.scope, slug: t.slug, id: settled.id });
        }

        if (complete) {
            const installed = await _dt_repo_ti.find_all_q({ where: { daemon_id } });
            for (const row of installed) {
                if (!kept.has(row.id)) await TeamService._mark_uninstalled(row);
            }
        }
        return out;
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
