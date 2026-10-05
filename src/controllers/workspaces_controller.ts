import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { WorkspaceService } from '../services/workspace.service.js';
import { RealmService } from '../services/realm.service.js';
import { AdminCheck } from '../lib/site_admin.js';
import { visible_realm_ids } from '../auth/route_policy/visible.js';
import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';
import { SortDirField, sort_by_field } from '../lib/list_sort.js';

/**
 * Who may see or touch which workspaces (Core issue #14).
 *   site admin   → every workspace
 *   daemon token → workspaces on daemons in the token's realm
 *   user         → workspaces on daemons in realms the user belongs to
 * `null` = no restriction (site admin).
 */
async function visible_daemon_ids(req: Request): Promise<string[] | null> {
    if (AdminCheck.is_site_admin(req)) return null;
    const auth = req.auth;
    if (auth?.auth_via === 'daemon_token') {
        return auth.realm_id ? RealmService.list_daemon_ids_in_realm(auth.realm_id) : [];
    }
    const user_id = req.auth?.user?.id;
    if (!user_id) throw ApiError.unauthorized('Authentication required');
    return RealmService.list_daemon_ids_for_user(String(user_id));
}

/** Realm-scoped list: the caller must be in that realm (site admins always may). */
async function assert_realm_readable(req: Request, realm_id: string): Promise<void> {
    if (AdminCheck.is_site_admin(req)) return;
    const auth = req.auth;
    if (auth?.auth_via === 'daemon_token') {
        if (auth.realm_id !== realm_id) throw ApiError.forbidden('Daemon token is not for this realm');
        return;
    }
    const user_id = req.auth?.user?.id;
    if (!user_id) throw ApiError.unauthorized('Authentication required');
    await RealmService.get(realm_id, String(user_id));
}

/**
 * Removing a workspace needs realm admin on a realm of its daemon (site admins
 * always may). Checked here too because removal by `path` gives the route
 * policy no id to look up.
 */
async function assert_workspace_admin(req: Request, daemon_id: string | null | undefined, label: string): Promise<void> {
    if (AdminCheck.is_site_admin(req)) return;
    await assert_workspace_visible(req, daemon_id, label);
    if (req.auth?.auth_via === 'daemon_token') throw ApiError.forbidden('Daemon tokens cannot remove workspaces');
    const [daemon_realms, admin_realms] = await Promise.all([
        RealmService.list_realms_for_daemon(String(daemon_id)),
        visible_realm_ids(String(req.auth?.user?.id ?? ''), { need: 'admin' }),
    ]);
    if (!daemon_realms.some((r) => admin_realms.includes(r.id))) {
        throw ApiError.forbidden('Realm admin required to remove a workspace');
    }
}

/** One workspace: its daemon must be visible to the caller. Unknown and hidden look the same (404). */
async function assert_workspace_visible(req: Request, daemon_id: string | null | undefined, label: string): Promise<void> {
    const ids = await visible_daemon_ids(req);
    if (ids === null) return;
    if (!daemon_id || !ids.includes(daemon_id)) throw ApiError.not_found(`workspace '${label}' not found`);
}

const get_schema = z.object({
    daemon_id: z.string().optional(),
    realm_id: z.string().optional()
        .describe('Only workspaces on a daemon of this realm, or that ran a run in it'),
    org_id: z.string().uuid().optional()
        .describe('Only workspaces on a daemon in a realm of this org, or that ran a run in the org (narrows what the caller may already see)'),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    /** Stored list only (400 with daemon_id, which asks the daemon live). */
    sort_by: sort_by_field(['name', 'created_at'], 'oldest first; name = name, else path'),
    sort_dir: SortDirField,
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

const log = get_logger('ctrl.workspaces');

export class WorkspaceController {
    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            log.debug('get', { user_id: req.auth?.user?.id });
            const body = get_schema.parse(req.body ?? {}) ?? {};

            /**
             * Live workspaces from a daemon (hard-cut from /v1/daemons/workspaces/get):
             * `data` is the daemon's `workspaces/get` data, `{ workspaces: [...] }`
             * (cliq-sdk 2.0 wire — before it, the raw daemon envelope).
             */
            if (body.daemon_id) {
                if (body.sort_by) throw ApiError.bad_request('sort_by applies to the stored workspace list, not a live daemon_id read', 'invalid_params');
                const user_id = req.auth?.user?.id;
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

            // Tenancy: a realm the caller is in, or (no realm) only what the caller can see.
            let daemon_ids: string[] | undefined;
            if (body.realm_id?.trim()) {
                await assert_realm_readable(req, body.realm_id.trim());
            } else {
                const visible = await visible_daemon_ids(req);
                if (visible !== null) daemon_ids = visible;
            }
            const result = await WorkspaceService.list({
                realm_id: body.realm_id,
                org_id: body.org_id,
                daemon_ids,
                limit: body.limit,
                offset: body.offset,
                sort_by: body.sort_by,
                sort_dir: body.sort_dir,
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
            log.debug('get_by_id', { user_id: req.auth?.user?.id });
            const body = get_by_id_schema.parse(req.body);
            const id = (body.id ?? body.workspace_id)!.trim();
            const workspace = await WorkspaceService.get(id);
            await assert_workspace_visible(req, workspace.daemon_id as string | null, id);
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
            log.debug('remove', { user_id: req.auth?.user?.id });
            const data = remove_schema.parse(req.body);
            if (!data.path && !data.id) throw ApiError.bad_request('path or id is required');
            const target = data.path
                ? await WorkspaceService.find_by_path(data.path)
                : await WorkspaceService.get(data.id!).catch(() => null);
            if (!target) {
                res.json({ ok: true, removed: false });
                return;
            }
            await assert_workspace_admin(req, target.daemon_id as string | null, data.id ?? data.path!);
            const removed = data.path
                ? await WorkspaceService.remove_by_path(data.path)
                : await WorkspaceService.remove(data.id!);
            log.info('workspace_removed', { id: data.id, path: data.path });
            res.json({ ok: true, removed });
        } catch (err) { next(err); }
    }
}
