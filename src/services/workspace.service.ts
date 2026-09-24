import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';

import { Workspace, WorkspaceTeam, Team, Scope, Run } from '../models/index.js';
import { ApiError } from '../lib/api_error.js';


export class WorkspaceService {

    static async list(opts?: {
        daemon_id?: string;
        realm_id?: string;
        limit?: number;
        offset?: number;
    }) {
        const daemon_id = opts?.daemon_id;
        const realm_id = opts?.realm_id?.trim();
        const limit = opts?.limit != null
            ? Math.min(Math.max(1, opts.limit), 200)
            : undefined;
        const offset = Math.max(0, opts?.offset ?? 0);

        const where: Record<string, unknown> = {};
        if (daemon_id) where.daemon_id = daemon_id;
        if (realm_id) {
            const { RealmService } = await import('./realm.service.js');
            const daemon_ids = await RealmService.list_daemon_ids_in_realm(realm_id);
            if (daemon_ids.length === 0) return { workspaces: [], total: 0 };
            where.daemon_id = { [Op.in]: daemon_ids };
        }

        const total = await Workspace.count({ where });
        const workspaces = await Workspace.findAll({
            where,
            include: [{
                model: WorkspaceTeam,
                as: 'workspace_teams',
                include: [{
                    model: Team,
                    as: 'team',
                    attributes: ['id', 'slug', 'scope_id'],
                    include: [{ model: Scope, as: 'scope', attributes: ['id', 'slug'] }],
                }],
            }],
            order: [['created_at', 'ASC']],
            ...(limit != null ? { limit, offset } : {}),
        });

        const ws_ids = workspaces.map(w => w.id);
        if (ws_ids.length === 0) return { workspaces: [], total };

        const [active_runs, latest_runs] = await Promise.all([
            Run.findAll({
                where: { workspace_id: { [Op.in]: ws_ids }, state: { [Op.in]: ['running', 'awaiting_input'] } },
                attributes: ['workspace_id', 'run_id', 'state', 'started_at'],
            }),
            Run.findAll({
                where: { workspace_id: { [Op.in]: ws_ids } },
                order: [['started_at', 'DESC']],
                attributes: ['workspace_id', 'run_id', 'state', 'started_at'],
            }),
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
                        scope: wt.team.scope?.slug ?? 'default',
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

    static async get(id: string) {
        const ws = await Workspace.findByPk(id);
        if (!ws) throw ApiError.not_found(`workspace '${id}' not found`);
        return WorkspaceService._enrich_single(ws);
    }

    static async get_by_path(path: string) {
        const ws = await Workspace.findOne({ where: { path } });
        if (!ws) throw ApiError.not_found(`workspace at '${path}' not found`);
        return WorkspaceService._enrich_single(ws);
    }

    static async find_by_path(path: string) {
        const ws = await Workspace.findOne({ where: { path } });
        if (!ws) return null;
        return WorkspaceService._enrich_single(ws);
    }

    private static async _enrich_single(ws: Workspace) {
        const [wt_rows, active_runs_rows, latest_run_row] = await Promise.all([
            WorkspaceTeam.findAll({
                where: { workspace_id: ws.id },
                include: [{
                    model: Team,
                    as: 'team',
                    attributes: ['id', 'slug', 'scope_id'],
                    include: [{ model: Scope, as: 'scope', attributes: ['id', 'slug'] }],
                }],
            }),
            Run.findAll({
                where: { workspace_id: ws.id, state: { [Op.in]: ['running', 'awaiting_input'] } },
                attributes: ['run_id', 'state', 'started_at'],
            }),
            Run.findOne({
                where: { workspace_id: ws.id },
                order: [['started_at', 'DESC']],
                attributes: ['run_id', 'state', 'started_at'],
            }),
        ]);

        const teams = wt_rows
            .filter((wt: any) => wt.team)
            .map((wt: any) => ({
                team_id: wt.team.id as string,
                slug: wt.team.slug as string,
                scope: wt.team.scope?.slug as string ?? 'default',
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
        const now = Date.now();
        const requested_id = id?.trim() || '';

        if (requested_id) {
            const by_id = await Workspace.findByPk(requested_id);
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

        const existing = await Workspace.findOne({ where: { path } });
        if (existing) {
            const name_next = name ?? existing.get('name');
            const updates: Record<string, unknown> = { name: name_next, updated_at: now };
            if (daemon_id) updates.daemon_id = daemon_id;
            await existing.update(updates);
            const enriched = await WorkspaceService._enrich_single(existing);
            return { record: enriched, created: false };
        }

        const ws = await Workspace.create({
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
        const now = Date.now();
        const id = input.id.trim();
        const path = input.path.trim();
        if (!id || !path) return;

        const by_id = await Workspace.findByPk(id);
        if (by_id) {
            await by_id.update({
                path,
                name: input.name ?? by_id.get('name'),
                daemon_id: input.daemon_id,
                updated_at: now,
            });
            return;
        }

        const by_daemon_path = await Workspace.findOne({
            where: { daemon_id: input.daemon_id, path },
        });
        const by_path = by_daemon_path ?? await Workspace.findOne({ where: { path } });

        if (by_path && by_path.id !== id) {
            await WorkspaceTeam.update(
                { workspace_id: id },
                { where: { workspace_id: by_path.id } },
            );
            await Run.update(
                { workspace_id: id },
                { where: { workspace_id: by_path.id } },
            );
            const preserved_name = input.name ?? by_path.get('name');
            const preserved_created = by_path.get('created_at') as number;
            await by_path.destroy();
            await Workspace.create({
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
            await Workspace.create({
                id,
                path,
                name: input.name ?? null,
                team_id: null,
                daemon_id: input.daemon_id,
                created_at: input.created_at ?? now,
                updated_at: now,
            });
        } catch {
            // Unique constraint race — ignore; next sync will converge
        }
    }

    static async remove(id: string): Promise<boolean> {
        const deleted = await Workspace.destroy({ where: { id } });
        return deleted > 0;
    }

    static async remove_by_path(path: string): Promise<boolean> {
        const deleted = await Workspace.destroy({ where: { path } });
        return deleted > 0;
    }

    static async add_team(workspace_id: string, team_id: string): Promise<boolean> {
        const now = Date.now();
        const [, created] = await WorkspaceTeam.findOrCreate({
            where: { workspace_id, team_id },
            defaults: { workspace_id, team_id, assembled_at: now },
        });

        const ws = await Workspace.findByPk(workspace_id);
        if (ws && !ws.get('team_id')) {
            await ws.update({ team_id, updated_at: now });
        }
        return created;
    }

    static async remove_team(workspace_id: string, team_id: string): Promise<boolean> {
        const deleted = await WorkspaceTeam.destroy({ where: { workspace_id, team_id } });
        if (deleted === 0) return false;

        const remaining = await WorkspaceService.list_teams(workspace_id);
        const next_team = remaining.length > 0 ? remaining[0].get('team_id') as string : null;
        await Workspace.update(
            { team_id: next_team, updated_at: Date.now() },
            { where: { id: workspace_id } },
        );
        return true;
    }

    static async list_teams(workspace_id: string) {
        return WorkspaceTeam.findAll({
            where: { workspace_id },
            order: [['assembled_at', 'ASC']],
        });
    }

    static async count_by_team(team_id: string): Promise<number> {
        const count = await WorkspaceTeam.count({ where: { team_id } });
        return Number(count);
    }
}
