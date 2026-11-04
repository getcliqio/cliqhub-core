/**
 * Once (PLAN-team-bundle S8): versions published before S8 get their sub-team calls recorded, and every realm team
 * gets its resolved tree, so daemons installing them from now on get the same tree as a team added after S8.
 *
 * 1. Each published version with no `team_version_sub_teams` rows: its team.yml's calls, recorded as publish would
 *    (the called team when it exists; a pin that isn't published is recorded without its version).
 * 2. Each realm team: its tree resolved now (pins as written, the latest published otherwise). A tree that can't be
 *    resolved (a sub-team never published, a cycle) is logged and left empty: those daemons keep resolving
 *    sub-teams locally, as before S8.
 *
 * Recorded under {@link SUB_TEAMS_KEY}.
 */
import { pinned_version } from '@getcliqio/cliq-sdk';

import { get_logger } from '../../lib/log.js';
import { get_sequelize } from '../../lib/sequelize.js';
import type { SettingsRepository } from '../../repositories/settings_repository.js';
import { TeamRepository } from '../../repositories/team_repository.js';
import { TeamVersionRepository } from '../../repositories/team_version_repository.js';
import { TeamVersionSubTeamRepository, type SubTeamRow } from '../../repositories/team_version_sub_team_repository.js';
import { sub_team_calls } from '../../services/team_sub_teams.js';
import { version_content } from '../../services/version_content.js';

const log = get_logger('db.migrate');

/** `cliq.settings` key recording the pass. */
export const SUB_TEAMS_KEY = 'migrate.sub_teams_backfill_2026_11';

/** What a pass did. */
export interface SubTeamsBackfillResult {
    already: boolean;
    versions: number;
    calls: number;
    trees: number;
    trees_failed: number;
}

/** Record pre-S8 versions' sub-team calls and every realm team's tree (see the file header). */
export async function sub_teams_backfill(deps: { settings: SettingsRepository }): Promise<SubTeamsBackfillResult> {
    if (await deps.settings.find_by_key(SUB_TEAMS_KEY)) return { already: true, versions: 0, calls: 0, trees: 0, trees_failed: 0 };
    const teams = new TeamRepository();
    const versions = new TeamVersionRepository();
    const sub_teams = new TeamVersionSubTeamRepository();
    let version_count = 0;
    let calls = 0;
    for (const v of await versions.list_published_packages()) {
        if ((await sub_teams.list_by_version(v.id)).length > 0) continue;
        const rows = await calls_of(v.id, teams, versions);
        if (rows.length === 0) continue;
        await get_sequelize().transaction((t) => sub_teams.create_many(rows, t));
        version_count += 1;
        calls += rows.length;
    }
    const { RealmTeamListService } = await import('../../services/realm_team_list.service.js');
    const trees = await RealmTeamListService.resolve_all_trees();
    const result = { versions: version_count, calls, trees: trees.resolved, trees_failed: trees.failed };
    await deps.settings.create(SUB_TEAMS_KEY, JSON.stringify({ at: new Date().toISOString(), ...result }));
    log.info('sub_teams_backfill_done', result);
    return { already: false, ...result };
}

/** A published version's calls, as publish records them (no visibility check: the version is already published). */
async function calls_of(version_id: string, teams: TeamRepository, versions: TeamVersionRepository): Promise<SubTeamRow[]> {
    let phases: unknown;
    try {
        phases = ((await version_content(version_id))?.team_yml as { phases?: unknown } | null)?.phases;
        const rows: SubTeamRow[] = [];
        for (const [position, call] of sub_team_calls(phases).entries()) {
            const team = await teams.find_by_name_and_scope(call.ref.slug, call.ref.scope);
            const pin = pinned_version(call.ref);
            const pinned = team && pin ? await versions.find_by_team_and_version(team.id, pin) : null;
            const ref = `@${call.ref.scope}/${call.ref.slug}${call.ref.version ? '@' + call.ref.version : ''}`;
            rows.push({ version_id, position, phase: call.phase, ref, team_id: team?.id ?? null, pinned_version_id: pinned?.id ?? null, may_call: call.may_call });
        }
        return rows;
    } catch (err) {
        // A version whose files can't be read or whose refs don't parse: it records nothing (as before S8).
        log.warn('sub_teams_backfill_version_skipped', { version_id, error: err instanceof Error ? err.message : String(err) });
        return [];
    }
}
