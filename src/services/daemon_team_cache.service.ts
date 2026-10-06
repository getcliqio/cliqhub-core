/**
 * Unified write path for syncing a daemon's team roster into the Hub
 * teams table. Called from /v1/teams/get { daemon_id } (on-demand live pull).
 *
 * NOTE: No longer called from heartbeat — heartbeat is pure liveness.
 * Team state is authoritative on Hub and synced via command outbox.
 *
 * Hub is authoritative: if a team was deleted from the Hub but the daemon
 * still reports it, the Hub refuses to re-create the row and re-issues
 * an uninstall dispatch to force the daemon into compliance.
 */

import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';
import { DaemonTeamRepository } from '../repositories/daemon_team_repository.js';
import { ScopeRepository } from '../repositories/scope_repository.js';
import { RealmDispatchQueueRepository } from '../repositories/realm_dispatch_queue_repository.js';
import { TeamService } from './teams_install_service.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('daemon-team-cache');
const daemon_team_repo = new DaemonTeamRepository();
const scope_repo = new ScopeRepository();
const rdq_repo = new RealmDispatchQueueRepository();

export interface HeartbeatTeamEntry {
    id: string;
    scope: string;
    slug: string;
    version: string | null;
    description: string | null;
    manifest: string;
    dockerfile?: string | null;
    dependencies?: string | null;
    created_at?: number;
}

export class DaemonTeamCacheService {

    /**
     * Sync daemon roster to Hub state:
     * - Teams with a recent Hub uninstall → reject and re-dispatch the uninstall
     * - Every other team → `TeamService.settle_slot` (one slot per daemon/scope/slug;
     *   an existing slot keeps its id, a new one takes the daemon's id)
     * - Slots not in the daemon roster → marked uninstalled (kept for their runs)
     */
    static async sync(daemon_id: string, teams: HeartbeatTeamEntry[], realm_id?: string): Promise<void> {
        const scope_slugs = [...new Set(teams.map((t) => t.scope).filter(Boolean))];
        const scope_map = await DaemonTeamCacheService._resolve_scopes(scope_slugs);
        const rejected = await DaemonTeamCacheService._recently_uninstalled(realm_id);

        const live_ids = new Set<string>();
        const now = Date.now();

        for (const t of teams) {
            if (!t.scope || !t.slug) continue;

            const team_label = `${t.scope}/${t.slug}`;

            // Hub deleted this team recently — refuse to re-create and re-issue uninstall.
            if (rejected.has(team_label)) {
                log.info(`rejecting ${team_label} from daemon ${daemon_id}: pending/recent uninstall`);
                void DaemonTeamCacheService._re_dispatch_uninstall(daemon_id, t.scope, t.slug, realm_id);
                continue;
            }

            const scope_id = scope_map.get(t.scope);
            if (!scope_id) {
                log.warn(`skipping team ${team_label}: unknown scope`);
                continue;
            }

            // Same rule as register: one slot per (daemon, scope, slug) for life.
            // Never claims another row; an id mismatch moves this daemon's runs
            // to the slot id instead of only logging it.
            const settled = await TeamService.settle_slot({
                daemon_id,
                scope_id,
                slug: t.slug,
                proposed_id: t.id || null,
                version: t.version ?? null,
                description: t.description ?? null,
                manifest: t.manifest ?? '',
                dockerfile: t.dockerfile ?? null,
                dependencies: t.dependencies ?? null,
            });
            live_ids.add(settled.id);
        }

        // Slots the daemon no longer reports are uninstalled (kept for their runs).
        const installed = await daemon_team_repo.find_all_q({ where: { daemon_id } });
        for (const row of installed) {
            if (!live_ids.has(row.id)) {
                await row.update({ uninstalled_at: now, updated_at: now });
            }
        }
    }

    /** Batch-resolve scope slugs to scope IDs in a single query. */
    private static async _resolve_scopes(slugs: string[]): Promise<Map<string, string>> {
        if (slugs.length === 0) return new Map();

        const rows = await scope_repo.find_all(
            { slug: { [Op.in]: slugs } },
            { attributes: ['id', 'slug'] },
        );

        const map = new Map<string, string>();
        for (const row of rows) {
            map.set(row.slug, row.id);
        }
        return map;
    }

    /**
     * Teams with an uninstall dispatch in the last 10 minutes (any status).
     * Hub considers these "deleted" — daemon must not re-add them.
     */
    private static async _recently_uninstalled(realm_id?: string): Promise<Set<string>> {
        const result = new Set<string>();
        if (!realm_id) return result;

        const cutoff = Date.now() - 10 * 60 * 1000;
        const rows = await rdq_repo.find_all(
            {
                realm_id,
                kind: 'uninstall',
                created_at: { [Op.gte]: cutoff },
            } as any,
            { attributes: ['payload'] },
        );

        for (const row of rows) {
            const p = row.payload as { scope?: string; slug?: string };
            if (p.scope && p.slug) result.add(`${p.scope}/${p.slug}`);
        }
        return result;
    }

    /** Fire-and-forget: queue another uninstall for a rogue team. */
    private static _re_dispatch_uninstall(
        daemon_id: string,
        scope: string,
        slug: string,
        realm_id?: string,
    ): void {
        if (!realm_id) return;
        void rdq_repo.find_or_create({
            where: {
                realm_id,
                kind: 'uninstall',
                status: { [Op.in]: ['queued', 'offered'] },
                payload: { scope, slug } as any,
            },
            defaults: {
                id: randomUUID(),
                realm_id,
                kind: 'uninstall',
                status: 'queued',
                payload: { scope, slug, daemon_ids: [daemon_id] },
                created_at: Date.now(),
            } as any,
        }).catch((err) => {
            log.warn(`failed to re-dispatch uninstall for ${scope}/${slug}: ${(err as Error).message}`);
        });
    }
}
