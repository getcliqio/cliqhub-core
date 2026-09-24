/**
 * Realm Team List — CRUD + apply for the declarative team set on a realm.
 *
 * The team list declares which teams should be installed on every daemon
 * in the realm. "Apply" fans out installs to all online daemons.
 * Auto-inject on registration reads this list to bootstrap new daemons.
 */

import { Realm, Team, Scope, Daemon, RealmAgentSetting, RealmMember } from '../models/index.js';
import { OrgAgentSetting } from '../db/models/index.js';
import { RealmService } from './realm.service.js';
import { DispatchService } from './dispatch.service.js';
import { InAppNotificationService } from './in_app_notification.service.js';
import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';
import type { TeamListEntry } from '../models/realm.model.js';
import { Op } from 'sequelize';

const log = get_logger('realm-team-list');

export interface ApplyTeamResult {
    scope: string;
    slug: string;
    daemon_results: Array<{ daemon_id: string; ok: boolean; error?: string }>;
}

export class RealmTeamListService {

    /**
     * Effective agent settings for installs: org defaults overwritten by
     * realm overrides. Shape matches daemon `/v1/install` `agent_settings`.
     */
    static async load_effective_agent_settings(
        realm_id: string,
        _user_id: string,
    ): Promise<Record<string, Record<string, string>>> {
        const out: Record<string, Record<string, string>> = {};

        try {
            const realm = await Realm.findByPk(realm_id, { attributes: ['org_id'] });
            const org_id = realm?.org_id;
            if (org_id) {
                const org_rows = await OrgAgentSetting.findAll({
                    where: { org_id },
                });
                for (const row of org_rows) {
                    const value = String((row as any).value ?? '').trim();
                    if (!value) continue;
                    const name = (row as any).agent_name;
                    const key = (row as any).setting_key;
                    if (!out[name]) out[name] = {};
                    out[name][key] = value;
                }
            }
        } catch {
            /* org settings may not be initialized yet */
        }

        const realm_rows = await RealmAgentSetting.findAll({ where: { realm_id } });
        for (const row of realm_rows) {
            const value = String(row.setting_value ?? '').trim();
            if (!value) continue;
            if (!out[row.agent_name]) out[row.agent_name] = {};
            out[row.agent_name][row.setting_key] = value;
        }

        return out;
    }

    /**
     * Re-run team-list inject on every online daemon in the realm.
     * Used after agent settings are fixed so previously-failed installs retry.
     */
    static async reinject_online_daemons(realm_id: string, user_id: string): Promise<void> {
        const memberships = await RealmMember.findAll({
            where: { realm_id, member_type: 'daemon' },
            attributes: ['member_id'],
            raw: true,
        });
        if (memberships.length === 0) return;

        const daemon_ids = memberships.map((m) => m.member_id);
        const daemons = await Daemon.findAll({
            where: { id: { [Op.in]: daemon_ids }, status: 'online' },
            attributes: ['id'],
        });

        for (const daemon of daemons) {
            await RealmTeamListService.inject_for_daemon(realm_id, daemon.id, user_id);
        }
    }

    /** Read the team list for a realm. */
    static async get(realm_id: string, user_id: string): Promise<TeamListEntry[]> {
        await RealmService.assert_member(realm_id, user_id);
        const realm = await Realm.findByPk(realm_id);
        if (!realm) throw ApiError.not_found('Realm not found');
        return (realm as any).team_list ?? [];
    }

    /** Replace the full team list. Deduplicates by scope+slug. */
    static async set(
        realm_id: string,
        user_id: string,
        teams: TeamListEntry[],
    ): Promise<TeamListEntry[]> {
        await RealmService.require_admin(realm_id, user_id);
        const deduped = dedupe(teams);
        await Realm.update(
            { team_list: deduped as any, updated_at: Date.now() },
            { where: { id: realm_id } },
        );
        log.info(`team list set: realm=${realm_id} count=${deduped.length}`);
        void import('./mesh_lifecycle.service.js')
            .then(({ MeshLifecycleService }) => MeshLifecycleService.on_skills_changed(realm_id))
            .catch(() => {});
        return deduped;
    }

    /** Add a single team to the list. Idempotent. */
    static async add(
        realm_id: string,
        user_id: string,
        entry: TeamListEntry,
    ): Promise<TeamListEntry[]> {
        await RealmService.require_admin(realm_id, user_id);
        const realm = await Realm.findByPk(realm_id);
        if (!realm) throw ApiError.not_found('Realm not found');

        const current: TeamListEntry[] = (realm as any).team_list ?? [];
        const key = `${entry.scope}/${entry.slug}`;
        if (current.some((e) => `${e.scope}/${e.slug}` === key)) {
            return current;
        }

        const updated = [...current, { scope: entry.scope, slug: entry.slug }];
        await Realm.update(
            { team_list: updated as any, updated_at: Date.now() },
            { where: { id: realm_id } },
        );
        log.info(`team list add: realm=${realm_id} team=${key}`);
        void import('./mesh_lifecycle.service.js')
            .then(({ MeshLifecycleService }) => MeshLifecycleService.on_skills_changed(realm_id))
            .catch(() => {});
        return updated;
    }

    /**
     * Seed built-in teams into a realm's team_list.
     *
     * Called during realm creation (not user-initiated) so it bypasses
     * the admin role check. Idempotent — skips teams already present.
     */
    static async seed_builtin_teams(realm_id: string): Promise<void> {
        const BUILTIN_TEAMS: TeamListEntry[] = [
            { scope: 'cliq', slug: 'hello-world' },
        ];

        const realm = await Realm.findByPk(realm_id);
        if (!realm) return;

        const current: TeamListEntry[] = (realm as any).team_list ?? [];
        const existing_keys = new Set(current.map((e) => `${e.scope}/${e.slug}`));

        const to_add = BUILTIN_TEAMS.filter(
            (t) => !existing_keys.has(`${t.scope}/${t.slug}`),
        );

        if (to_add.length === 0) return;

        const updated = [...current, ...to_add];
        await Realm.update(
            { team_list: updated as any, updated_at: Date.now() },
            { where: { id: realm_id } },
        );
        log.info(`seeded builtin teams into realm=${realm_id}: ${to_add.map((t) => `${t.scope}/${t.slug}`).join(', ')}`);
    }

    /** Remove a single team from the list. Idempotent. */
    static async remove(
        realm_id: string,
        user_id: string,
        entry: TeamListEntry,
    ): Promise<TeamListEntry[]> {
        await RealmService.require_admin(realm_id, user_id);
        const realm = await Realm.findByPk(realm_id);
        if (!realm) throw ApiError.not_found('Realm not found');

        const current: TeamListEntry[] = (realm as any).team_list ?? [];
        const key = `${entry.scope}/${entry.slug}`;
        const updated = current.filter((e) => `${e.scope}/${e.slug}` !== key);

        if (updated.length === current.length) {
            return current;
        }

        await Realm.update(
            { team_list: updated as any, updated_at: Date.now() },
            { where: { id: realm_id } },
        );
        log.info(`team list remove: realm=${realm_id} team=${key}`);
        void import('./mesh_lifecycle.service.js')
            .then(({ MeshLifecycleService }) => MeshLifecycleService.on_skills_changed(realm_id))
            .catch(() => {});
        return updated;
    }

    /**
     * Apply the team list to all online daemons in the realm.
     * Loops over each entry, resolves it, and fans out installs.
     */
    static async apply(
        realm_id: string,
        user_id: string,
        scope_ids?: string[],
        org_ids?: string[],
    ): Promise<ApplyTeamResult[]> {
        await RealmService.require_admin(realm_id, user_id);
        const realm = await Realm.findByPk(realm_id);
        if (!realm) throw ApiError.not_found('Realm not found');

        const team_list: TeamListEntry[] = (realm as any).team_list ?? [];
        if (team_list.length === 0) {
            return [];
        }

        const results: ApplyTeamResult[] = [];

        for (const entry of team_list) {
            const team_ref = `${entry.scope}/${entry.slug}`;
            try {
                const install_result = await DispatchService.install_team({
                    team_id: team_ref,
                    realm_id,
                    user_id,
                    scope_ids,
                    org_ids,
                });
                results.push({
                    scope: entry.scope,
                    slug: entry.slug,
                    daemon_results: install_result.results,
                });
            } catch (err) {
                log.warn(
                    `apply team list: failed to install ${team_ref} on realm ${realm_id}: `
                    + (err instanceof Error ? err.message : String(err)),
                );
                results.push({
                    scope: entry.scope,
                    slug: entry.slug,
                    daemon_results: [{
                        daemon_id: '*',
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                    }],
                });
            }
        }

        log.info(`team list applied: realm=${realm_id} teams=${team_list.length}`);
        return results;
    }

    /**
     * Force-sync one team onto every online daemon in the realm.
     * Overwrites an already-installed copy with Hub's latest version
     * and pushes effective agent settings (same as inject).
     */
    static async sync_team(
        realm_id: string,
        user_id: string,
        entry: TeamListEntry,
        scope_ids?: string[],
        org_ids?: string[],
    ): Promise<ApplyTeamResult> {
        await RealmService.require_admin(realm_id, user_id);
        const realm = await Realm.findByPk(realm_id);
        if (!realm) throw ApiError.not_found('Realm not found');

        const team_list: TeamListEntry[] = (realm as any).team_list ?? [];
        const on_list = team_list.some(
            (e) => e.scope === entry.scope && e.slug === entry.slug,
        );
        if (!on_list) {
            throw ApiError.bad_request(
                `Team '${entry.scope}/${entry.slug}' is not on this realm's team list`,
            );
        }

        const agent_settings = await RealmTeamListService.load_effective_agent_settings(
            realm_id,
            user_id,
        );
        const has_agent_settings = Object.keys(agent_settings).length > 0;
        const team_ref = `${entry.scope}/${entry.slug}`;

        try {
            const install_result = await DispatchService.install_team({
                team_id: team_ref,
                realm_id,
                user_id,
                scope_ids,
                org_ids,
                force: true,
                ...(has_agent_settings ? { agent_settings } : {}),
            });
            log.info(`force sync: realm=${realm_id} team=${team_ref}`);
            return {
                scope: entry.scope,
                slug: entry.slug,
                daemon_results: install_result.results,
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(`force sync failed: realm=${realm_id} team=${team_ref}: ${message}`);
            return {
                scope: entry.scope,
                slug: entry.slug,
                daemon_results: [{
                    daemon_id: '*',
                    ok: false,
                    error: message,
                }],
            };
        }
    }

    /**
     * Best-effort install of the realm's team list onto a single daemon,
     * plus reconciliation: uninstall any teams on the daemon that are
     * not in the list (handles returning daemons with stale teams).
     * Called fire-and-forget during daemon registration.
     */
    static async inject_for_daemon(
        realm_id: string,
        daemon_id: string,
        user_id: string,
        scope_ids?: string[],
        org_ids?: string[],
    ): Promise<void> {
        try {
            const realm = await Realm.findByPk(realm_id);
            if (!realm) return;

            const team_list: TeamListEntry[] = (realm as any).team_list ?? [];
            const desired_keys = new Set(team_list.map((e) => `${e.scope}/${e.slug}`));
            const agent_settings = await RealmTeamListService.load_effective_agent_settings(
                realm_id,
                user_id,
            );
            const has_agent_settings = Object.keys(agent_settings).length > 0;

            // Install desired teams. Collect any failures so we can surface an
            // in-app notification at the end — a silent server-log warn is not
            // observable to the realm owner and this used to swallow whole-batch
            // failures during the daemon-register / sync-register race.
            const failed: Array<{ team_ref: string; error: string }> = [];
            for (const entry of team_list) {
                const team_ref = `${entry.scope}/${entry.slug}`;
                try {
                    await DispatchService.install_team({
                        team_id: team_ref,
                        daemon_ids: [daemon_id],
                        user_id,
                        scope_ids,
                        org_ids,
                        ...(has_agent_settings ? { agent_settings } : {}),
                    });
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    log.warn(`inject team ${team_ref} to daemon ${daemon_id}: ${message}`);
                    failed.push({ team_ref, error: message });
                }
            }

            // Reconcile: uninstall teams on daemon that are not in the list
            await RealmTeamListService._reconcile_stale(daemon_id, desired_keys, user_id);

            log.info(
                `team list injected: daemon=${daemon_id} realm=${realm_id} `
                + `teams=${team_list.length} failed=${failed.length}`,
            );

            if (failed.length > 0) {
                await RealmTeamListService._notify_inject_failure(
                    realm_id, daemon_id, failed, team_list.length,
                );
            }
        } catch (err) {
            log.warn(
                `inject_for_daemon failed: realm=${realm_id} daemon=${daemon_id}: `
                + (err instanceof Error ? err.message : String(err)),
            );
        }
    }

    /**
     * Emit an in-app notification when one or more team-list installs
     * failed. Best-effort; a notification-persist failure only logs.
     */
    private static async _notify_inject_failure(
        realm_id: string,
        daemon_id: string,
        failed: Array<{ team_ref: string; error: string }>,
        total: number,
    ): Promise<void> {
        try {
            const daemon = await Daemon.findByPk(daemon_id);
            const daemon_name = daemon?.name ?? null;
            const preview = failed.slice(0, 5).map((f) => `${f.team_ref} (${f.error})`).join('; ');
            const more = failed.length > 5 ? ` and ${failed.length - 5} more` : '';
            await InAppNotificationService.create_from_payload({
                event: 'realm.team_list.install_failed',
                title: `${failed.length}/${total} team install${failed.length === 1 ? '' : 's'} failed`,
                message: `Daemon ${daemon_name ?? daemon_id}: ${preview}${more}`,
                realm_id,
                daemon_id,
                daemon_name: daemon_name ?? undefined,
                severity: 'warning',
            });
        } catch (err) {
            log.warn(
                `notify inject failure: realm=${realm_id} daemon=${daemon_id}: `
                + (err instanceof Error ? err.message : String(err)),
            );
        }
    }

    /**
     * Public entry point for post-heartbeat reconciliation.
     * Reads the realm's team list and uninstalls any teams on the daemon
     * that are not in the declared set. Safe to call frequently — no-ops
     * if the daemon's roster already matches.
     */
    static async reconcile_daemon(
        realm_id: string,
        daemon_id: string,
        user_id: string,
    ): Promise<void> {
        try {
            const realm = await Realm.findByPk(realm_id);
            if (!realm) return;

            const team_list: TeamListEntry[] = (realm as any).team_list ?? [];
            const desired_keys = new Set(team_list.map((e) => `${e.scope}/${e.slug}`));
            await RealmTeamListService._reconcile_stale(daemon_id, desired_keys, user_id);
        } catch (err) {
            log.warn(
                `reconcile_daemon failed: realm=${realm_id} daemon=${daemon_id}: `
                + (err instanceof Error ? err.message : String(err)),
            );
        }
    }

    /**
     * Uninstall teams on a daemon that are not in the desired set.
     * Uses the heartbeat-synced teams table to find what the daemon has.
     */
    private static async _reconcile_stale(
        daemon_id: string,
        desired_keys: Set<string>,
        user_id: string,
    ): Promise<void> {
        const installed = await Team.findAll({ where: { daemon_id } });
        if (installed.length === 0) return;

        const scope_ids_on_daemon = [...new Set(installed.map((t) => t.scope_id))];
        const scopes = await Scope.findAll({
            where: { id: scope_ids_on_daemon },
            attributes: ['id', 'slug'],
        });
        const scope_map = new Map(scopes.map((s) => [s.id, s.slug]));

        for (const row of installed) {
            const scope_slug = scope_map.get(row.scope_id);
            if (!scope_slug) continue;
            const key = `${scope_slug}/${row.slug}`;
            if (desired_keys.has(key)) continue;

            try {
                await DispatchService.uninstall_team({
                    scope: scope_slug,
                    slug: row.slug,
                    daemon_ids: [daemon_id],
                    user_id,
                });
                log.info(`reconcile: uninstalled stale team ${key} from daemon ${daemon_id}`);
            } catch (err) {
                log.warn(
                    `reconcile: failed to uninstall ${key} from daemon ${daemon_id}: `
                    + (err instanceof Error ? err.message : String(err)),
                );
            }
        }
    }
    /**
     * Remove a team from ALL realm team_lists and purge from cliq.teams.
     * Used during registry-level team deletion to cascade across realms.
     */
    static async remove_from_all_realms(scope_slug: string, team_slug: string): Promise<void> {
        const key = `${scope_slug}/${team_slug}`;

        const realms = await Realm.findAll({ attributes: ['id', 'team_list'] });
        for (const realm of realms) {
            const current: TeamListEntry[] = (realm as any).team_list ?? [];
            const updated = current.filter((e) => `${e.scope}/${e.slug}` !== key);
            if (updated.length < current.length) {
                await Realm.update(
                    { team_list: updated as any, updated_at: Date.now() },
                    { where: { id: (realm as any).id } },
                );
                log.info(`cascade remove: realm=${(realm as any).id} team=${key}`);
            }
        }

        const scope_row = await Scope.findOne({ where: { slug: scope_slug }, attributes: ['id'] });
        if (scope_row) {
            await Team.destroy({ where: { scope_id: (scope_row as any).id, slug: team_slug } } as any);
            log.info(`cascade purge cliq.teams: ${key}`);
        }
    }
}

/** Deduplicate team list entries by scope+slug. */
function dedupe(teams: TeamListEntry[]): TeamListEntry[] {
    const seen = new Set<string>();
    const result: TeamListEntry[] = [];
    for (const t of teams) {
        const key = `${t.scope}/${t.slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ scope: t.scope, slug: t.slug });
    }
    return result;
}
