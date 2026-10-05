import { randomUUID } from 'node:crypto';
import { Op, col, fn, literal, type WhereOptions } from 'sequelize';
import { list_order, type SortColumns, type SortDir } from '../lib/list_sort.js';

import { get_logger } from '../lib/log.js';
import { get_sequelize } from '../lib/sequelize.js';
import type { Workspace } from '../models/workspace.model.js';
import { WorkspaceTeam, DaemonTeam, Daemon, Realm, Org } from '../models/index.js';
import { WorkspaceRepository } from '../repositories/workspace_repository.js';
import { WorkspaceTeamRepository } from '../repositories/workspace_team_repository.js';
import { DaemonTeamRepository } from '../repositories/daemon_team_repository.js';
import { RunRepository } from '../repositories/run_repository.js';
import { ScopeRepository } from '../repositories/scope_repository.js';

const log = get_logger('svc.workspace');

const _ws_repo_w = new WorkspaceRepository();
const _wst_repo = new WorkspaceTeamRepository();
const _dt_repo_w = new DaemonTeamRepository();
const _run_repo_w = new RunRepository();
const _scope_repo_w = new ScopeRepository();
import { ApiError } from '../lib/api_error.js';

/** Where a workspace runs: daemons, realms and orgs (its own daemon plus every run's). */
export interface WorkspaceTenantContext {
    daemons: Array<{ id: string; name: string | null }>;
    realms: Array<{ id: string; slug: string; name: string; org_id: string | null }>;
    orgs: Array<{ id: string; slug: string; display_name: string }>;
}

/** `workspaces/get` sort keys. */
export type WorkspaceSortKey = 'name' | 'created_at';

/** `workspaces/get` sort key → ORDER BY (name falls back to the path, as the UI shows it). */
const WORKSPACE_SORT_COLUMNS: SortColumns<WorkspaceSortKey> = {
    name: (d) => [[fn('LOWER', fn('COALESCE', col('Workspace.name'), col('Workspace.path'))), d]],
    created_at: (d) => [['created_at', d]],
};

export class WorkspaceService {

    static async list(opts?: {
        daemon_id?: string;
        /** Workspaces on a daemon of this realm, or that ran a run in it. */
        realm_id?: string;
        /** Workspaces on a daemon of one of this org's realms, or that ran a run in the org. */
        org_id?: string;
        /** Only workspaces on these daemons (tenancy filter from the controller). */
        daemon_ids?: string[];
        limit?: number;
        offset?: number;
        sort_by?: WorkspaceSortKey;
        sort_dir?: SortDir;
    }) {
        log.debug('list', { daemon_id: opts?.daemon_id, realm_id: opts?.realm_id });
        const daemon_id = opts?.daemon_id;
        const realm_id = opts?.realm_id?.trim();
        const limit = opts?.limit != null
            ? Math.min(Math.max(1, opts.limit), 200)
            : undefined;
        const offset = Math.max(0, opts?.offset ?? 0);

        const where: Record<string, unknown> = {};
        if (daemon_id) where.daemon_id = daemon_id;
        if (opts?.daemon_ids) {
            if (opts.daemon_ids.length === 0) return { workspaces: [], total: 0 };
            where.daemon_id = daemon_id
                ? (opts.daemon_ids.includes(daemon_id) ? daemon_id : '__none__')
                : { [Op.in]: opts.daemon_ids };
        }
        const and: unknown[] = [];
        if (realm_id) and.push(WorkspaceService._in_tenant_where('realm_id', realm_id));
        const org_id = opts?.org_id?.trim();
        if (org_id) and.push(WorkspaceService._in_tenant_where('org_id', org_id));
        if (and.length) (where as Record<symbol, unknown>)[Op.and] = and;

        const total = await _ws_repo_w.find_count(where as any);
        const workspaces = await _ws_repo_w.find_all_q({
            where,
            include: [{
                model: WorkspaceTeam,
                as: 'workspace_teams',
                include: [{
                    model: DaemonTeam,
                    as: 'team',
                    attributes: ['id', 'slug', 'scope_id'],
                }],
            }],
            order: list_order(WORKSPACE_SORT_COLUMNS, opts ?? {}, [['created_at', 'ASC']]),
            ...(limit != null ? { limit, offset } : {}),
        });

        const ws_ids = workspaces.map(w => w.id);
        if (ws_ids.length === 0) return { workspaces: [], total };

        // Collect scope_ids from nested teams for a single bulk lookup.
        const nested_scope_ids = [...new Set(
            workspaces.flatMap(ws =>
                ((ws as any).workspace_teams ?? [])
                    .map((wt: any) => wt.team?.scope_id as string | undefined)
                    .filter((id: string | undefined): id is string => Boolean(id)),
            ),
        )];
        const ws_scopes = nested_scope_ids.length === 0
            ? []
            : await _scope_repo_w.find_all_q({ where: { id: { [Op.in]: nested_scope_ids } }, attributes: ['id', 'slug'] });
        const scope_slug_by_id = new Map(ws_scopes.map(s => [s.id, s.slug]));

        const [active_runs, latest_runs, context] = await Promise.all([
            _run_repo_w.find_all_q({
                where: { workspace_id: { [Op.in]: ws_ids }, state: { [Op.in]: ['running', 'awaiting_input'] } },
                attributes: ['workspace_id', 'run_id', 'state', 'started_at'],
            }),
            _run_repo_w.find_all_q({
                where: { workspace_id: { [Op.in]: ws_ids } },
                order: [['started_at', 'DESC']],
                attributes: ['workspace_id', 'run_id', 'state', 'started_at'],
            }),
            WorkspaceService._tenant_context(workspaces),
        ]);

        const active_by_ws = new Map<string, Array<{ run_id: string; state: string; started_at: number }>>();
        for (const r of active_runs) {
            const list = active_by_ws.get(r.workspace_id) ?? [];
            list.push({ run_id: r.run_id, state: r.state, started_at: r.started_at });
            active_by_ws.set(r.workspace_id, list);
        }

        const latest_by_ws = new Map<string, typeof latest_runs[0]>();
        for (const r of latest_runs) {
            if (!latest_by_ws.has(r.workspace_id)) latest_by_ws.set(r.workspace_id, r);
        }

        return {
            workspaces: workspaces.map(ws => {
                const wt_rows = (ws as any).workspace_teams ?? [];
                const teams = wt_rows
                    .filter((wt: any) => wt.team)
                    .map((wt: any) => ({
                        team_id: wt.team.id,
                        slug: wt.team.slug,
                        scope: scope_slug_by_id.get(wt.team.scope_id) ?? 'default',
                    }));

                const active = active_by_ws.get(ws.id) ?? [];
                const latest = latest_by_ws.get(ws.id);

                return {
                    workspace_id: ws.id,
                    workspace_dir: ws.path,
                    id: ws.id,
                    path: ws.path,
                    name: ws.name ?? undefined,
                    registered: true,
                    exists: true,
                    assembled: teams.length > 0,
                    daemon_id: ws.daemon_id,
                    ...(context.get(ws.id) ?? { daemons: [], realms: [], orgs: [] }),
                    teams,
                    active_runs: active,
                    latest_run: latest
                        ? { run_id: latest.run_id, state: latest.state, started_at: latest.started_at }
                        : null,
                    created_at: ws.created_at,
                    updated_at: ws.updated_at,
                };
            }),
            total,
        };
    }

    /**
     * A workspace belongs to a realm (or org) through its daemon's realm
     * memberships, or through the runs it ran there — most workspaces have no
     * daemon_id, so the runs are what ties them to a tenant.
     */
    private static _in_tenant_where(field: 'realm_id' | 'org_id', id: string): WhereOptions {
        const v = get_sequelize().escape(id);
        const realm_daemons = field === 'realm_id'
            ? `SELECT rm.member_id::text FROM realm_members rm WHERE rm.member_type = 'daemon' AND rm.realm_id::text = ${v}`
            : `SELECT rm.member_id::text FROM realm_members rm JOIN realms r ON r.id::text = rm.realm_id::text WHERE rm.member_type = 'daemon' AND r.org_id::text = ${v}`;
        return {
            [Op.or]: [
                { daemon_id: { [Op.in]: literal(`(${realm_daemons})`) } },
                { id: { [Op.in]: literal(`(SELECT tr.workspace_id FROM team_runs tr WHERE tr.${field}::text = ${v})`) } },
            ],
        };
    }

    /** workspace_id → the daemons, realms and orgs it runs on (its own daemon plus every run's). */
    private static async _tenant_context(workspaces: Workspace[]): Promise<Map<string, WorkspaceTenantContext>> {
        const out = new Map<string, WorkspaceTenantContext>();
        if (workspaces.length === 0) return out;
        const runs = await _run_repo_w.find_all_q({
            where: { workspace_id: { [Op.in]: workspaces.map((w) => w.id) } },
            attributes: ['workspace_id', 'daemon_id', 'realm_id', 'org_id'],
            group: ['workspace_id', 'daemon_id', 'realm_id', 'org_id'],
            raw: true,
        }) as unknown as Array<{ workspace_id: string; daemon_id: string | null; realm_id: string | null; org_id: string | null }>;
        const own_daemons = [...new Set(workspaces.map((w) => w.daemon_id).filter((d): d is string => Boolean(d)))];
        const { RealmService } = await import('./realm.service.js');
        const realms_of_daemon = await RealmService.list_realms_by_daemon_ids(own_daemons);

        const ids = new Map<string, { daemons: Set<string>; realms: Set<string>; orgs: Set<string> }>();
        const slot = (ws_id: string) => {
            const s = ids.get(ws_id) ?? { daemons: new Set<string>(), realms: new Set<string>(), orgs: new Set<string>() };
            ids.set(ws_id, s);
            return s;
        };
        for (const w of workspaces) {
            if (!w.daemon_id) continue;
            const s = slot(w.id);
            s.daemons.add(w.daemon_id);
            for (const r of realms_of_daemon.get(w.daemon_id) ?? []) s.realms.add(r.id);
        }
        for (const r of runs) {
            const s = slot(r.workspace_id);
            if (r.daemon_id) s.daemons.add(r.daemon_id);
            if (r.realm_id) s.realms.add(r.realm_id);
            if (r.org_id) s.orgs.add(String(r.org_id));
        }
        const all = (k: 'daemons' | 'realms') => [...new Set([...ids.values()].flatMap((s) => [...s[k]]))];
        const [daemons, realms] = await Promise.all([
            Daemon.findAll({ where: { id: { [Op.in]: all('daemons') } }, attributes: ['id', 'name', 'hostname'], raw: true }) as unknown as Promise<Array<{ id: string; name: string | null; hostname: string | null }>>,
            Realm.findAll({ where: { id: { [Op.in]: all('realms') } }, attributes: ['id', 'slug', 'name', 'org_id'], raw: true }) as unknown as Promise<Array<{ id: string; slug: string; name: string; org_id: string | null }>>,
        ]);
        const realm_by_id = new Map(realms.map((r) => [r.id, r]));
        for (const s of ids.values()) {
            for (const rid of s.realms) {
                const org = realm_by_id.get(rid)?.org_id;
                if (org) s.orgs.add(String(org));
            }
        }
        const orgs = await Org.findAll({ where: { id: { [Op.in]: [...new Set([...ids.values()].flatMap((s) => [...s.orgs]))] } }, attributes: ['id', 'slug', 'display_name'], raw: true }) as unknown as Array<{ id: string; slug: string; display_name: string | null }>;
        const daemon_by_id = new Map(daemons.map((d) => [d.id, d]));
        const org_by_id = new Map(orgs.map((o) => [String(o.id), o]));
        for (const [ws_id, s] of ids) {
            out.set(ws_id, {
                daemons: [...s.daemons].map((id) => ({ id, name: daemon_by_id.get(id)?.name ?? daemon_by_id.get(id)?.hostname ?? null })),
                realms: [...s.realms].flatMap((id) => {
                    const r = realm_by_id.get(id);
                    return r ? [{ id, slug: r.slug, name: r.name, org_id: r.org_id ? String(r.org_id) : null }] : [];
                }),
                orgs: [...s.orgs].flatMap((id) => {
                    const o = org_by_id.get(id);
                    return o ? [{ id, slug: o.slug, display_name: o.display_name ?? o.slug }] : [];
                }),
            });
        }
        return out;
    }

    static async get(id: string) {
        log.debug('get', { id });
        const ws = await _ws_repo_w.find_by_id(id);
        if (!ws) throw ApiError.not_found(`workspace '${id}' not found`);
        return WorkspaceService._enrich_single(ws);
    }

    static async get_by_path(path: string) {
        log.debug('get_by_path', { path });
        const ws = await _ws_repo_w.find_one_q({ where: { path } });
        if (!ws) throw ApiError.not_found(`workspace at '${path}' not found`);
        return WorkspaceService._enrich_single(ws);
    }

    static async find_by_path(path: string) {
        log.debug('find_by_path', { path });
        const ws = await _ws_repo_w.find_one_q({ where: { path } });
        if (!ws) return null;
        return WorkspaceService._enrich_single(ws);
    }

    private static async _enrich_single(ws: Workspace) {
        const [wt_rows, active_runs_rows, latest_run_row] = await Promise.all([
            _wst_repo.find_all_q({
                where: { workspace_id: ws.id },
                include: [{
                    model: DaemonTeam,
                    as: 'team',
                    attributes: ['id', 'slug', 'scope_id'],
                }],
            }),
            _run_repo_w.find_all_q({
                where: { workspace_id: ws.id, state: { [Op.in]: ['running', 'awaiting_input'] } },
                attributes: ['run_id', 'state', 'started_at'],
            }),
            _run_repo_w.find_one_q({
                where: { workspace_id: ws.id },
                order: [['started_at', 'DESC']],
                attributes: ['run_id', 'state', 'started_at'],
            }),
        ]);

        const detail_scope_ids = [...new Set(
            wt_rows
                .map((wt: any) => wt.team?.scope_id as string | undefined)
                .filter((id): id is string => Boolean(id)),
        )];
        const detail_scopes = detail_scope_ids.length === 0
            ? []
            : await _scope_repo_w.find_all_q({ where: { id: { [Op.in]: detail_scope_ids } }, attributes: ['id', 'slug'] });
        const detail_scope_slug_by_id = new Map(detail_scopes.map(s => [s.id, s.slug]));

        const teams = wt_rows
            .filter((wt: any) => wt.team)
            .map((wt: any) => ({
                team_id: wt.team.id as string,
                slug: wt.team.slug as string,
                scope: detail_scope_slug_by_id.get(wt.team.scope_id) ?? 'default',
            }));

        return {
            workspace_id: ws.id,
            workspace_dir: ws.path,
            id: ws.id,
            path: ws.path,
            name: ws.name ?? undefined,
            registered: true,
            exists: true,
            assembled: teams.length > 0,
            daemon_id: ws.daemon_id,
            teams,
            active_runs: active_runs_rows.map(r => ({ run_id: r.run_id, state: r.state, started_at: r.started_at })),
            latest_run: latest_run_row
                ? { run_id: latest_run_row.run_id, state: latest_run_row.state, started_at: latest_run_row.started_at }
                : null,
            created_at: ws.created_at,
            updated_at: ws.updated_at,
        };
    }

    static async upsert_by_path(
        path: string,
        name?: string | null,
        daemon_id?: string | null,
        id?: string | null,
    ) {
        log.debug('upsert_by_path', { path, daemon_id });
        const now = Date.now();
        const requested_id = id?.trim() || '';

        if (requested_id) {
            const by_id = await _ws_repo_w.find_by_id(requested_id);
            if (by_id) {
                const name_next = name ?? by_id.get('name');
                const updates: Record<string, unknown> = {
                    path,
                    name: name_next,
                    updated_at: now,
                };
                if (daemon_id) updates.daemon_id = daemon_id;
                await by_id.update(updates);
                const enriched = await WorkspaceService._enrich_single(by_id);
                return { record: enriched, created: false };
            }
        }

        const existing = await _ws_repo_w.find_one_q({ where: { path } });
        if (existing) {
            const name_next = name ?? existing.get('name');
            const updates: Record<string, unknown> = { name: name_next, updated_at: now };
            if (daemon_id) updates.daemon_id = daemon_id;
            await existing.update(updates);
            const enriched = await WorkspaceService._enrich_single(existing);
            return { record: enriched, created: false };
        }

        const ws = await _ws_repo_w.create_one({
            id: requested_id || randomUUID(),
            path,
            name: name ?? null,
            team_id: null,
            daemon_id: daemon_id ?? null,
            created_at: now,
            updated_at: now,
        });
        const enriched = await WorkspaceService._enrich_single(ws);
        return { record: enriched, created: true };
    }

    /**
     * Mirror a live daemon workspace into Hub DB under the daemon's workspace id.
     * Re-keys an existing path row when Hub previously assigned a different id.
     */
    static async mirror_from_daemon(input: {
        id: string;
        path: string;
        name?: string | null;
        daemon_id: string;
        created_at?: number;
    }): Promise<void> {
        log.debug('mirror_from_daemon', { id: input.id, daemon_id: input.daemon_id });
        const now = Date.now();
        const id = input.id.trim();
        const path = input.path.trim();
        if (!id || !path) return;

        const by_id = await _ws_repo_w.find_by_id(id);
        if (by_id) {
            await by_id.update({
                path,
                name: input.name ?? by_id.get('name'),
                daemon_id: input.daemon_id,
                updated_at: now,
            });
            return;
        }

        const by_daemon_path = await _ws_repo_w.find_one_q({
            where: { daemon_id: input.daemon_id, path },
        });
        const by_path = by_daemon_path ?? await _ws_repo_w.find_one_q({ where: { path } });

        if (by_path && by_path.id !== id) {
            await _wst_repo.update_where(
                { workspace_id: by_path.id } as any,
                { workspace_id: id } as any,
            );
            await _run_repo_w.update_where(
                { workspace_id: by_path.id } as any,
                { workspace_id: id } as any,
            );
            const preserved_name = input.name ?? by_path.get('name');
            const preserved_created = by_path.get('created_at') as number;
            await by_path.destroy();
            await _ws_repo_w.create_one({
                id,
                path,
                name: preserved_name ?? null,
                team_id: null,
                daemon_id: input.daemon_id,
                created_at: input.created_at ?? preserved_created ?? now,
                updated_at: now,
            });
            return;
        }

        if (by_path) {
            await by_path.update({
                name: input.name ?? by_path.get('name'),
                daemon_id: input.daemon_id,
                updated_at: now,
            });
            return;
        }

        try {
            await _ws_repo_w.create_one({
                id,
                path,
                name: input.name ?? null,
                team_id: null,
                daemon_id: input.daemon_id,
                created_at: input.created_at ?? now,
                updated_at: now,
            });
        } catch (err) {
            log.debug('workspace_insert_race', { error: err instanceof Error ? err.message : String(err) });
            // Unique constraint race — ignore; next sync will converge
        }
    }

    static async remove(id: string): Promise<boolean> {
        log.debug('remove', { id });
        const deleted = await _ws_repo_w.delete_where({ id } as any);
        if (deleted > 0) log.info('workspace_removed', { id });
        return deleted > 0;
    }

    static async remove_by_path(path: string): Promise<boolean> {
        log.debug('remove_by_path', { path });
        const deleted = await _ws_repo_w.delete_where({ path } as any);
        if (deleted > 0) log.info('workspace_removed_by_path', { path });
        return deleted > 0;
    }

    static async add_team(workspace_id: string, team_id: string): Promise<boolean> {
        log.debug('add_team', { workspace_id, team_id });
        const now = Date.now();
        const [, created] = await _wst_repo.find_or_create({
            where: { workspace_id, team_id },
            defaults: { workspace_id, team_id, assembled_at: now },
        } as any);

        const ws = await _ws_repo_w.find_by_id(workspace_id);
        if (ws && !ws.get('team_id')) {
            await ws.update({ team_id, updated_at: now });
        }
        return created;
    }

    static async remove_team(workspace_id: string, team_id: string): Promise<boolean> {
        log.debug('remove_team', { workspace_id, team_id });
        const deleted = await _wst_repo.delete_where({ workspace_id, team_id } as any);
        if (deleted === 0) return false;

        const remaining = await WorkspaceService.list_teams(workspace_id);
        const next_team = remaining.length > 0 ? remaining[0].get('team_id') as string : null;
        await _ws_repo_w.update_where(
            { id: workspace_id } as any,
            { team_id: next_team, updated_at: Date.now() } as any,
        );
        return true;
    }

    static async list_teams(workspace_id: string) {
        return _wst_repo.find_all_q({
            where: { workspace_id },
            order: [['assembled_at', 'ASC']],
        });
    }

    static async count_by_team(team_id: string): Promise<number> {
        const count = await _wst_repo.find_count({ team_id } as any);
        return Number(count);
    }
}
