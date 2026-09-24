import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { WorkspaceService } from '../services/workspace.service.js';

const get_schema = z.object({
    daemon_id: z.string().optional(),
    realm_id: z.string().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
}).optional();

const get_by_id_schema = z.object({
    id: z.string().min(1).optional(),
    workspace_id: z.string().min(1).optional(),
}).refine((v) => Boolean(v.id?.trim() || v.workspace_id?.trim()), {
    message: 'id or workspace_id is required',
});

const remove_schema = z.object({
    path: z.string().optional(),
    id: z.string().optional(),
});

export class WorkspaceController {
    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = get_schema.parse(req.body ?? {}) ?? {};

            /** Live workspaces from a daemon (hard-cut from /v1/daemons/workspaces/get). */
            if (body.daemon_id) {
                const user_id = req.user?.user_id ?? req.auth?.user?.id;
                if (!user_id) {
                    res.status(401).json({ ok: false, error: 'Authentication required' });
                    return;
                }
                const { live_workspaces_from_daemon } = await import(
                    '../services/daemon_live_inventory.service.js'
                );
                const result = await live_workspaces_from_daemon(
                    body.daemon_id,
                    String(user_id),
                );
                res.json({ ok: true, data: result });
                return;
            }

            const result = await WorkspaceService.list({
                realm_id: body.realm_id,
                limit: body.limit,
                offset: body.offset,
            });
            res.json({
                ok: true,
                workspaces: result.workspaces,
                total: result.total,
                offset: body.offset ?? 0,
                limit: body.limit ?? result.total,
            });
        } catch (err) { next(err); }
    }

    static async get_by_id(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = get_by_id_schema.parse(req.body);
            const id = (body.id ?? body.workspace_id)!.trim();
            const workspace = await WorkspaceService.get(id);
            const team_rows = await WorkspaceService.list_teams(id);
            const by_id = new Map(
                (workspace.teams ?? []).map((t) => [t.team_id, t]),
            );
            const teams = team_rows.map((row) => {
                const team_id = String(row.get('team_id'));
                const meta = by_id.get(team_id);
                return {
                    team_id,
                    scope: meta?.scope ?? null,
                    slug: meta?.slug ?? null,
                    assembled_at: row.get('assembled_at'),
                };
            });
            res.json({ ok: true, workspace, teams });
        } catch (err) { next(err); }
    }

    static async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const data = remove_schema.parse(req.body);
            const removed = data.path
                ? await WorkspaceService.remove_by_path(data.path)
                : await WorkspaceService.remove(data.id!);
            res.json({ ok: true, removed });
        } catch (err) { next(err); }
    }
}
