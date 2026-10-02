/**
 * Live installed teams / workspaces from a daemon (read-through cache).
 * Called from POST /v1/teams/get|{daemon_id} and /v1/workspaces/get|{daemon_id}.
 */

import { DispatchService } from './dispatch.service.js';
import { WorkspaceService } from './workspace.service.js';
import { WorkspaceRepository } from '../repositories/workspace_repository.js';
import { DaemonTeamCacheService, type HeartbeatTeamEntry } from './daemon_team_cache.service.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('svc.daemon_inventory');

const workspace_repo = new WorkspaceRepository();

export async function live_teams_from_daemon(
    daemon_id: string,
    user_id: string,
): Promise<{ teams?: unknown[] }> {
    log.debug('live_teams_from_daemon', { daemon_id, user_id });
    const result = await DispatchService.query_daemon<{ teams?: any[] }>(
        daemon_id,
        '/v1/teams/get',
        {},
        user_id,
    );

    const live_teams: any[] = Array.isArray(result.teams) ? result.teams : [];
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
    return result;
}

export async function live_workspaces_from_daemon(
    daemon_id: string,
    user_id: string,
): Promise<{ workspaces?: unknown[] }> {
    log.debug('live_workspaces_from_daemon', { daemon_id, user_id });
    const result = await DispatchService.query_daemon<{ workspaces?: unknown[] }>(
        daemon_id,
        '/v1/workspaces/get',
        {},
        user_id,
    );

    try {
        await _cache_workspaces(daemon_id, result);
    } catch {
        /* best-effort — still return live daemon data */
    }

    return result;
}

/** The workspace rows of the daemon's `workspaces/get` data. */
function _extract_live_workspaces(result: { workspaces?: unknown[] }): Array<Record<string, unknown>> {
    return Array.isArray(result.workspaces) ? result.workspaces as Array<Record<string, unknown>> : [];
}

async function _cache_workspaces(daemon_id: string, result: { workspaces?: unknown[] }): Promise<void> {
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

    const all_backend = await workspace_repo.find_all({ daemon_id });
    for (const row of all_backend) {
        if (!live_ids.has(row.id)) {
            await row.destroy();
        }
    }
}
