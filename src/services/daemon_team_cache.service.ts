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
import { Team, Scope } from '../models/index.js';
import { RealmDispatchQueue } from '../models/realm_dispatch_queue.model.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('daemon-team-cache');

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
     * Sync daemon roster to Hub state. Hub is authoritative:
     * - Teams already in Hub → update metadata
     * - Teams NOT in Hub but with a recent uninstall → reject and re-dispatch
     * - Teams NOT in Hub and no recent uninstall → accept (new CLI install)
     * - Hub rows not in daemon roster → prune
     */
    static async sync(daemon_id: string, teams: HeartbeatTeamEntry[], realm_id?: string): Promise<void> {
        const scope_slugs = [...new Set(teams.map((t) => t.scope).filter(Boolean))];
        const scope_map = await DaemonTeamCacheService._resolve_scopes(scope_slugs);
        const rejected = await DaemonTeamCacheService._recently_uninstalled(realm_id);

        const live_keys = new Set<string>();
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

            const composite_key = `${scope_id}\0${t.slug}`;
            live_keys.add(composite_key);

            let existing = await Team.findOne({
                where: { daemon_id, scope_id, slug: t.slug },
            });
            if (!existing) {
                existing = await Team.findOne({
                    where: { daemon_id: { [Op.is]: null } as any, scope_id, slug: t.slug },
                });
            }

            if (existing) {
                if (existing.id !== t.id) {
                    // Hub id is authoritative for Hub-managed rows. Log drift;
                    // next force-install rebinds the daemon to Hub's id.
                    log.warn(
                        `team id drift daemon=${daemon_id} ${team_label}: hub=${existing.id} daemon=${t.id}`,
                    );
                }
                await existing.update({
                    daemon_id,
                    version: t.version ?? existing.version,
                    description: t.description ?? existing.description,
                    manifest: t.manifest ?? existing.manifest,
                    updated_at: now,
                });
            } else {
                // Prefer the daemon-reported id for CLI-originated installs so
                // Hub and daemon share one PK. Hub-driven installs mint first
                // and pass that id down, so heartbeat usually hits the branch above.
                await Team.create({
                    id: t.id || randomUUID(),
                    daemon_id,
                    scope_id,
                    slug: t.slug,
                    version: t.version ?? null,
                    description: t.description ?? null,
                    manifest: t.manifest ?? '',
                    dockerfile: t.dockerfile ?? null,
                    dependencies: t.dependencies ?? null,
                    created_at: t.created_at ?? now,
                    updated_at: now,
                });
            }
        }

        // Prune Hub rows the daemon no longer reports.
        const all_rows = await Team.findAll({ where: { daemon_id } });
        for (const row of all_rows) {
            const key = `${row.scope_id}\0${row.slug}`;
            if (!live_keys.has(key)) {
                try {
                    await row.destroy();
                } catch {
                    await row.update({ daemon_id: null } as any);
                }
            }
        }
    }

    /** Batch-resolve scope slugs to scope IDs in a single query. */
    private static async _resolve_scopes(slugs: string[]): Promise<Map<string, string>> {
        if (slugs.length === 0) return new Map();

        const rows = await Scope.findAll({
            where: { slug: { [Op.in]: slugs } },
            attributes: ['id', 'slug'],
        });

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
        const rows = await RealmDispatchQueue.findAll({
            where: {
                realm_id,
                kind: 'uninstall',
                created_at: { [Op.gte]: cutoff },
            },
            attributes: ['payload'],
        });

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
        void RealmDispatchQueue.findOrCreate({
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
