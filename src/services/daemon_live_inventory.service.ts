/**
 * Live installed teams / workspaces from a daemon (read-through cache).
 * Called from POST /v1/teams/get|{daemon_id} and /v1/workspaces/get|{daemon_id}.
 */

import { DispatchService } from './dispatch.service.js';
import { WorkspaceService } from './workspace.service.js';
import { Workspace } from '../models/index.js';
import { DaemonTeamCacheService, type HeartbeatTeamEntry } from './daemon_team_cache.service.js';

export async function live_teams_from_daemon(
    daemon_id: string,
    user_id: string,
): Promise<Record<string, unknown> | null> {
    const result = await DispatchService.query_daemon(
        daemon_id,
        '/v1/teams/get',
        {},
        user_id,
        'team_list',
    );

    const live_teams: any[] = (result as any)?.payload?.data?.teams ?? [];
    const entries: HeartbeatTeamEntry[] = live_teams
        .filter((t: any) => t.team_id && t.scope && t.slug)
        .map((t: any) => ({
            id: t.team_id,
            scope: t.scope,
            slug: t.slug,
            version: t.version ?? null,
            description: t.description ?? null,
            manifest: t.manifest ?? '',
            dockerfile: t.dockerfile ?? null,
            dependencies: t.dependencies ?? null,
            created_at: t.created_at ?? Date.now(),
        }));

    void DaemonTeamCacheService.sync(daemon_id, entries).catch(() => {});
    return result as Record<string, unknown> | null;
}

export async function live_workspaces_from_daemon(
    daemon_id: string,
    user_id: string,
): Promise<Record<string, unknown> | null> {
    const result = await DispatchService.query_daemon(
        daemon_id,
        '/v1/workspaces/get',
        {},
        user_id,
        'workspace_list',
    ) as Record<string, unknown> | null;

    try {
        await _cache_workspaces(daemon_id, result);
    } catch {
        /* best-effort — still return live daemon data */
    }

    return result;
}

function _extract_live_workspaces(result: unknown): Array<Record<string, unknown>> {
    const root = result as Record<string, unknown> | null;
    if (!root || typeof root !== 'object') return [];
    const nested = (root.payload as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined;
    const list = nested?.workspaces
        ?? (root as { workspaces?: unknown }).workspaces
        ?? (root.data as { workspaces?: unknown } | undefined)?.workspaces
        ?? [];
    return Array.isArray(list) ? list as Array<Record<string, unknown>> : [];
}

async function _cache_workspaces(daemon_id: string, result: unknown): Promise<void> {
    const live_workspaces = _extract_live_workspaces(result);
    const live_ids = new Set<string>();

    for (const ws of live_workspaces) {
        const ws_id = String(ws.workspace_id ?? ws.id ?? '').trim();
        const ws_path = String(ws.workspace_dir ?? ws.path ?? '').trim();
        if (!ws_id || !ws_path) continue;
        live_ids.add(ws_id);

        await WorkspaceService.mirror_from_daemon({
            id: ws_id,
            path: ws_path,
            name: typeof ws.name === 'string' ? ws.name : null,
            daemon_id,
            created_at: typeof ws.created_at === 'number' ? ws.created_at : undefined,
        });
    }

    const all_backend = await Workspace.findAll({ where: { daemon_id } });
    for (const row of all_backend) {
        if (!live_ids.has(row.id)) {
            await row.destroy();
        }
    }
}
