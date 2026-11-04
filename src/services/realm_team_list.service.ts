/**
 * Realm Team List — the teams a realm runs, one version each (PLAN-team-bundle S4.1).
 *
 * The list lives in `cliq.realm_teams` (team and version by id). **This service is the only code that reads or
 * writes it**: everything that asks "which teams does this realm run" or "is this team on the realm" calls the
 * reads below (a guard test fails the build otherwise). Adding a team fans out installs to the realm's online
 * daemons; a daemon that registers gets the list injected, and stale teams on it are uninstalled.
 */

import { RealmRepository } from '../repositories/realm_repository.js';
import { DaemonTeamRepository } from '../repositories/daemon_team_repository.js';
import { DaemonRepository } from '../repositories/daemon_repository.js';
import { RealmAgentSettingRepository } from '../repositories/realm_agent_setting_repository.js';
import { ScopeRepository } from '../repositories/scope_repository.js';
import { TeamRepository } from '../repositories/team_repository.js';
import { TeamVersionRepository } from '../repositories/team_version_repository.js';
import { OrgAgentSettingRepository } from '../repositories/org_agent_setting_repository.js';
import { RealmTeamRepository, type RealmTeamRow, type RealmTeamTreeRow } from '../repositories/realm_team_repository.js';
import { get_sequelize } from '../lib/sequelize.js';
import { resolve_realm_tree } from './realm_team_tree.js';

const _realm_repo_rtl = new RealmRepository();
const _dt_repo_rtl = new DaemonTeamRepository();
const _daemon_repo_rtl = new DaemonRepository();
const _ras_repo = new RealmAgentSettingRepository();
const _scope_repo_rtl = new ScopeRepository();
const _team_repo_rtl = new TeamRepository();
const _team_version_repo_rtl = new TeamVersionRepository();
const _org_agent_setting_repo = new OrgAgentSettingRepository();
const _realm_team_repo = new RealmTeamRepository();
import { DispatchService } from './dispatch.service.js';
import { command_outbox_enqueue } from './command_outbox.service.js';
import { InAppNotificationService } from './in_app_notification.service.js';
import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';
import type { Transaction } from 'sequelize';
import { BUILTIN_TEAMS as SDK_BUILTIN_TEAMS } from '@getcliqio/cliq-sdk';

const log = get_logger('realm-team-list');

/** A team on a realm: its ids, and its names as labels. */
export type RealmTeamEntry = RealmTeamRow;

/**
 * The built-in teams every new realm starts with, at their latest published version: cliq-sdk's `BUILTIN_TEAMS`
 * (hello-world, hug-example, hello-hug — PLAN-team-bundle S6), the same ones CliqHub seeds and cliqd installs.
 */
const BUILTIN_TEAMS: Array<{ scope: string; slug: string }> = SDK_BUILTIN_TEAMS.map((t) => ({ scope: t.scope, slug: t.name }));

const key_of = (e: { scope: string | null; slug: string }) => `${e.scope ?? ''}/${e.slug}`;

/** A team on the list as the routes answer it: its ids and its names. */
export interface RealmTeamListItem {
    team_id: string;
    version_id: string;
    scope: string;
    slug: string;
    version: string;
}

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
            const realm = await _realm_repo_rtl.find_by_id(realm_id, { attributes: ['org_id'] });
            const org_id = realm?.org_id;
            if (org_id) {
                const org_rows = await _org_agent_setting_repo.find_all_q({
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
        } catch (err) {
            log.debug('org_settings_unavailable', { error: err instanceof Error ? err.message : String(err) });
            /* org settings may not be initialized yet */
        }

        const realm_rows = await _ras_repo.find_all_q({ where: { realm_id } });
        for (const row of realm_rows) {
            const value = String((row as any).setting_value ?? '').trim();
            if (!value) continue;
            if (!out[row.agent_name]) out[row.agent_name] = {};
            out[row.agent_name][row.setting_key] = value;
        }

        return out;
    }

    /**
     * Send changed agent settings to the online daemons they affect. A realm save goes to that
     * realm; an org save goes to every realm of the org, minus keys a realm sets itself. Each key
     * carries its effective value (realm over org), or null when neither sets it.
     */
    static async push_settings_change(input: {
        org_id: string;
        realm_id?: string;
        agent_name: string;
        keys: string[];
    }): Promise<void> {
        if (input.keys.length === 0) return;
        const realm_ids = input.realm_id
            ? [input.realm_id]
            : (await _realm_repo_rtl.find_all_q({ where: { org_id: input.org_id, deleted: false }, attributes: ['id'] }))
                .map((r) => r.id);

        for (const realm_id of realm_ids) {
            let keys = input.keys;
            if (!input.realm_id) {
                const own = await _ras_repo.find_all_q({
                    where: { realm_id, agent_name: input.agent_name, setting_key: keys },
                });
                const overridden = new Set(own
                    .filter((row) => String(row.setting_value ?? '').trim())
                    .map((row) => row.setting_key));
                keys = keys.filter((key) => !overridden.has(key));
                if (keys.length === 0) continue;
            }
            const effective = (await RealmTeamListService.load_effective_agent_settings(realm_id, ''))[input.agent_name] ?? {};
            const settings: Record<string, string | null> = {};
            for (const key of keys) settings[key] = effective[key] ?? null;
            await DispatchService.push_agent_settings_to_realm({ realm_id, agent_name: input.agent_name, settings });
        }
    }

    /**
     * Send one daemon the realm's full effective agent settings (realm over org), so a daemon that
     * was offline while settings were saved catches up when it registers.
     */
    static async push_settings_to_daemon(realm_id: string, daemon_id: string): Promise<void> {
        const effective = await RealmTeamListService.load_effective_agent_settings(realm_id, '');
        for (const [agent_name, keys] of Object.entries(effective)) {
            for (const [key, value] of Object.entries(keys)) {
                await command_outbox_enqueue(daemon_id, '/v1/settings/set', {
                    workspace_dir: null,
                    key: `agents.${agent_name}.${key}`,
                    value,
                });
            }
        }
    }

    // ─── Reads: every reader of a realm's teams goes through these ────────────

    /** A realm's teams: ids, and names as labels. */
    static async entries(realm_id: string): Promise<RealmTeamEntry[]> {
        return _realm_team_repo.list(realm_id);
    }

    /** Several realms' teams, by realm id. */
    static async entries_for(realm_ids: string[]): Promise<Map<string, RealmTeamEntry[]>> {
        const out = new Map<string, RealmTeamEntry[]>(realm_ids.map((id) => [id, []]));
        for (const row of await _realm_team_repo.list_for(realm_ids)) out.get(row.realm_id)?.push(row);
        return out;
    }

    /** A realm's teams as `scope/slug` keys (for callers that still hold names, until they hold ids). */
    static async keys(realm_id: string): Promise<Set<string>> {
        return new Set((await _realm_team_repo.list(realm_id)).map(key_of));
    }

    /** One team on a realm, by its catalog id, or null when it isn't on the realm. */
    static async find(realm_id: string, team_id: string): Promise<RealmTeamEntry | null> {
        return _realm_team_repo.find(realm_id, team_id);
    }

    /** Whether a team (by catalog id) is on a realm. */
    static async has(realm_id: string, team_id: string): Promise<boolean> {
        return (await _realm_team_repo.find(realm_id, team_id)) !== null;
    }

    /** Whether a team (by name) is on a realm. */
    static async has_ref(realm_id: string, scope: string | null, slug: string): Promise<boolean> {
        const team = await _team_repo_rtl.find_by_name_and_scope(slug, scope);
        return team ? RealmTeamListService.has(realm_id, team.id) : false;
    }

    /** The realms that run a team (optionally only an org's). */
    static async realms_with(team_id: string, org_id?: string): Promise<string[]> {
        return _realm_team_repo.realm_ids_with(team_id, org_id);
    }

    // ─── Writes ───────────────────────────────────────────────────────────────

    /**
     * The team and version a built-in team gets, by name (the seed): the version asked for (it must be published
     * and not withdrawn), else the latest.
     *
     * @throws ApiError 404 when the team isn't in the catalog, has no version, or the version doesn't exist.
     */
    static async resolve(scope: string, slug: string, version?: string): Promise<{ team_id: string; version_id: string; version: string }> {
        const team = await _team_repo_rtl.find_by_name_and_scope(slug, scope);
        if (!team) throw ApiError.not_found(`Team '@${scope}/${slug}' isn't published`);
        if (version) {
            const row = await _team_version_repo_rtl.find_current_by_team_and_version(team.id, version);
            if (!row) throw ApiError.not_found(`Version ${version} of '@${scope}/${slug}' doesn't exist or was withdrawn`);
            return { team_id: team.id, version_id: row.id, version };
        }
        const latest = await _team_version_repo_rtl.find_latest_ref(team.id);
        if (!latest) throw ApiError.not_found(`Team '@${scope}/${slug}' has no published version`);
        return { team_id: team.id, version_id: latest.id, version: latest.version };
    }

    /**
     * A catalog team by id, with its names.
     *
     * @throws ApiError 404 when there is no such team.
     */
    static async team(team_id: string): Promise<{ id: string; scope: string; slug: string }> {
        const team = await _team_repo_rtl.find_by_id(team_id);
        if (!team) throw ApiError.not_found('Team not found');
        return { id: team.id, scope: team.scope ?? '', slug: team.name };
    }

    /**
     * The version a realm records for a team: the one asked for (it must be the team's, published and not
     * withdrawn), else the latest.
     *
     * @throws ApiError 404 when the version isn't the team's or can't be installed, or the team has none.
     */
    static async resolve_by_id(team: { id: string; scope: string; slug: string }, version_id?: string): Promise<{ version_id: string; version: string }> {
        if (version_id) {
            const row = await _team_version_repo_rtl.find_current_by_id(version_id);
            if (!row || row.team_id !== team.id) throw ApiError.not_found(`That version of '@${team.scope}/${team.slug}' doesn't exist or was withdrawn`);
            return { version_id: row.id, version: row.version };
        }
        const latest = await _team_version_repo_rtl.find_latest_ref(team.id);
        if (!latest) throw ApiError.not_found(`Team '@${team.scope}/${team.slug}' has no published version`);
        return { version_id: latest.id, version: latest.version };
    }

    /**
     * Put a team on the list at a version (default: the latest published). A team already on the list moves to
     * that version — so adding it again without one moves the realm to the latest (the builder's "update realms").
     */
    static async add(
        realm_id: string,
        user_id: string,
        ref: { team_id: string; version_id?: string },
    ): Promise<RealmTeamListItem[]> {
        // Callers authorized this: realms/add_team (route policy: operate + realms.teams.manage).
        const realm = await _realm_repo_rtl.find_by_id(realm_id);
        if (!realm) throw ApiError.not_found('Realm not found');

        const team = await RealmTeamListService.team(ref.team_id);
        const { version_id, version } = await RealmTeamListService.resolve_by_id(team, ref.version_id);
        const existing = await _realm_team_repo.find(realm_id, team.id);
        if (existing?.version_id !== version_id) {
            // Its sub-team tree, resolved now (S8): a tree that can't be resolved refuses the add, before anything changes.
            const tree = await resolve_realm_tree({ team_id: team.id, version_id, scope: team.scope, slug: team.slug });
            await get_sequelize().transaction(async (t) => {
                await _realm_team_repo.put(realm_id, team.id, version_id, t);
                await _realm_team_repo.replace_tree(realm_id, team.id, tree, t);
            });
            log.info(`team list ${existing ? 'version' : 'add'}: realm=${realm_id} team=${key_of(team)} version=${version}`);
            void import('./mesh_lifecycle.service.js')
                .then(({ MeshLifecycleService }) => MeshLifecycleService.on_skills_changed(realm_id))
                .catch(() => {});
        }
        return RealmTeamListService.list_entries(realm_id);
    }

    /**
     * Seed the built-in teams into a realm, at their latest published version. Called during realm creation (not
     * user-initiated), so no admin check. Idempotent — skips teams already on the realm.
     */
    static async seed_builtin_teams(realm_id: string): Promise<void> {
        const added: string[] = [];
        for (const t of BUILTIN_TEAMS) {
            try {
                const { team_id, version_id } = await RealmTeamListService.resolve(t.scope, t.slug);
                if (await _realm_team_repo.find(realm_id, team_id)) continue;
                await _realm_team_repo.put(realm_id, team_id, version_id);
                added.push(key_of(t));
            } catch {
                // Not published on this hub (e.g. a fresh local stack): nothing to seed.
            }
        }
        if (added.length) log.info(`seeded builtin teams into realm=${realm_id}: ${added.join(', ')}`);
    }

    /** A realm team's sub-team tree, as resolved when the realm added (or moved) it (S8). */
    static async tree(realm_id: string, team_id: string): Promise<RealmTeamTreeRow[]> {
        return _realm_team_repo.tree(realm_id, team_id);
    }

    /**
     * "Sub-team updates" (S8): for each team on a realm, how many unpinned calls in its tree have a newer published
     * version than the one the realm resolved — they're used once the team is added again.
     *
     * @returns Catalog team id → count (teams with no tree aren't in the map).
     */
    static async sub_team_updates(realm_id: string): Promise<Map<string, number>> {
        const rows = await _realm_team_repo.realm_trees(realm_id);
        const latest = await _team_version_repo_rtl.find_latest_refs([...new Set(rows.map((r) => r.team_id))]);
        const counts = new Map<string, number>();
        for (const r of rows) {
            if (!counts.has(r.root_team_id)) counts.set(r.root_team_id, 0);
            const unpinned = /^@[^/@\s]+\/[^/@\s]+$/.test(r.ref);
            const newest = latest.get(r.team_id);
            if (unpinned && newest && newest.id !== r.version_id) counts.set(r.root_team_id, counts.get(r.root_team_id)! + 1);
        }
        return counts;
    }

    /** Whether a daemon may download a version as part of a realm team's tree it has installed (S8). */
    static async in_daemon_tree(daemon_id: string, version_id: string): Promise<boolean> {
        return _realm_team_repo.in_daemon_tree(daemon_id, version_id);
    }

    /**
     * Resolve every realm team's tree now (the S8 backfill). One that can't be resolved is logged and left empty.
     *
     * @returns How many were resolved and how many failed.
     */
    static async resolve_all_trees(): Promise<{ resolved: number; failed: number }> {
        let resolved = 0;
        let failed = 0;
        for (const rt of await _realm_team_repo.list_all()) {
            try {
                const tree = await resolve_realm_tree({ team_id: rt.team_id, version_id: rt.version_id, scope: rt.scope, slug: rt.slug });
                await _realm_team_repo.replace_tree(rt.realm_id, rt.team_id, tree);
                resolved += 1;
            } catch (err) {
                failed += 1;
                log.warn('realm_team_tree_unresolved', { realm_id: rt.realm_id, team: key_of(rt), error: err instanceof Error ? err.message : String(err) });
            }
        }
        return { resolved, failed };
    }

    /** Remove a single team from the list. Idempotent. */
    static async remove(
        realm_id: string,
        user_id: string,
        team_id: string,
    ): Promise<RealmTeamListItem[]> {
        // Callers authorized this: realms/remove_team (route policy: operate + realms.teams.manage).
        const realm = await _realm_repo_rtl.find_by_id(realm_id);
        if (!realm) throw ApiError.not_found('Realm not found');

        if (await _realm_team_repo.take_off(realm_id, team_id)) {
            log.info(`team list remove: realm=${realm_id} team=${team_id}`);
            void import('./mesh_lifecycle.service.js')
                .then(({ MeshLifecycleService }) => MeshLifecycleService.on_skills_changed(realm_id))
                .catch(() => {});
        }
        return RealmTeamListService.list_entries(realm_id);
    }

    /** Take a team off the given realms (unpublish: it leaves every realm at once, in the caller's transaction). */
    static async take_off_realms(team_id: string, realm_ids: string[], transaction?: Transaction): Promise<void> {
        await _realm_team_repo.take_off_realms(team_id, realm_ids, transaction);
    }

    /** The list as the routes answer it: ids and names per team. */
    private static async list_entries(realm_id: string): Promise<RealmTeamListItem[]> {
        return (await _realm_team_repo.list(realm_id)).map((e) => ({ team_id: e.team_id, version_id: e.version_id, scope: e.scope, slug: e.slug, version: e.version }));
    }

    /**
     * Force-sync one team onto every online daemon in the realm.
     * Installs the version on the realm's list (over any other installed copy)
     * and pushes effective agent settings (same as inject).
     */
    static async sync_team(
        realm_id: string,
        user_id: string,
        team_id: string,
        org_ids?: string[],
    ): Promise<ApplyTeamResult> {
        // Callers authorized this: realms/add_team, right after add (route policy: operate + realms.teams.manage).
        const realm = await _realm_repo_rtl.find_by_id(realm_id);
        if (!realm) throw ApiError.not_found('Realm not found');

        const listed = await _realm_team_repo.find(realm_id, team_id);
        if (!listed) throw ApiError.bad_request(`Team ${team_id} is not on this realm's team list`);
        const entry = { scope: listed.scope, slug: listed.slug };

        const agent_settings = await RealmTeamListService.load_effective_agent_settings(
            realm_id,
            user_id,
        );
        const has_agent_settings = Object.keys(agent_settings).length > 0;
        const team_ref = `${entry.scope}/${entry.slug}`;

        try {
            const install_result = await DispatchService.install_team({
                team_id: team_ref,
                version: listed.version,
                realm_id,
                user_id,
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
        org_ids?: string[],
    ): Promise<void> {
        try {
            const team_list = await _realm_team_repo.list(realm_id);
            const desired_keys = new Set(team_list.map(key_of));
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
                const team_ref = key_of(entry);
                try {
                    await DispatchService.install_team({
                        team_id: team_ref,
                        version: entry.version,
                        daemon_ids: [daemon_id],
                        user_id,
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
            const daemon = await _daemon_repo_rtl.find_by_id(daemon_id);
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
     * Uninstall teams on a daemon that are not in the desired set.
     * Uses the heartbeat-synced teams table to find what the daemon has.
     */
    private static async _reconcile_stale(
        daemon_id: string,
        desired_keys: Set<string>,
        user_id: string,
    ): Promise<void> {
        const installed = await _dt_repo_rtl.find_all_q({ where: { daemon_id } });
        if (installed.length === 0) return;

        const scope_ids_on_daemon = [...new Set(installed.map((t) => t.scope_id))];
        const scopes = await _scope_repo_rtl.find_all_q({
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
     * Take a team off every realm (team deletion cascades here), and mark its daemon slots uninstalled. Runs keep
     * their team.
     */
    static async remove_from_all_realms(scope_slug: string, team_slug: string): Promise<void> {
        const key = `${scope_slug}/${team_slug}`;
        const team = await _team_repo_rtl.find_by_name_and_scope(team_slug, scope_slug);
        if (!team) return;
        const realm_ids = await _realm_team_repo.take_off_everywhere(team.id);
        for (const realm_id of realm_ids) log.info(`cascade remove: realm=${realm_id} team=${key}`);

        // Slots are marked uninstalled, not deleted: their runs keep the team. Found by the catalog team, not by name.
        await _dt_repo_rtl.update_where(
            { team_id: team.id } as any,
            { uninstalled_at: Date.now(), updated_at: Date.now() } as any,
        );
        log.info(`cascade uninstall daemon team slots: ${key}`);
    }
}
