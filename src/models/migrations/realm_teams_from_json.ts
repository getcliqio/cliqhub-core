/**
 * Every startup until it has run (PLAN-team-bundle S4.1): each realm's `team_list` JSON names become
 * `cliq.realm_teams` rows, by id.
 *
 * For each entry `{ scope, slug, version? }`: the catalog team with that scope and name, and the version named
 * (published; a withdrawn one is kept as it is what the realm runs), or, with none (the version-less
 * `cliq/hello-world` new realms used to get), the team's latest published version. A row a realm already has is
 * left as it is. An entry with no catalog team, or a version that doesn't exist, is not moved: it is logged and
 * stored under {@link REALM_TEAMS_REPORT_KEY}, and the next start tries again. The pass is recorded only when every
 * entry has moved. The JSON column is kept (nothing reads or writes it any more); a later step drops it.
 */
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { get_logger } from '../../lib/log.js';
import { get_sequelize } from '../../lib/sequelize.js';
import type { SettingsRepository } from '../../repositories/settings_repository.js';
import type { TeamVersionRepository } from '../../repositories/team_version_repository.js';

const log = get_logger('db.migrate');

/** `cliq.settings` key recording that every realm's list moved. */
export const REALM_TEAMS_KEY = 'migrate.realm_teams_from_json_2026_11';
/** `cliq.settings` key holding the entries the last pass couldn't move. */
export const REALM_TEAMS_REPORT_KEY = 'migrate.realm_teams_from_json_report';

/** What a pass did. */
export interface RealmTeamsFromJsonResult {
    already: boolean;
    /** `<realm_id> <scope>/<slug>@<version>` moved. */
    moved: string[];
    /** `<realm_id> <scope>/<slug>: <why>` not moved. */
    problems: string[];
}

type Entry = { scope?: unknown; slug?: unknown; version?: unknown };

/**
 * Move every realm's JSON team list to `realm_teams`.
 *
 * @param deps - Settings (the pass record and report) and versions (the latest of a team).
 */
export async function realm_teams_from_json(deps: {
    settings: SettingsRepository;
    versions: Pick<TeamVersionRepository, 'find_latest_ref'>;
}): Promise<RealmTeamsFromJsonResult> {
    if (await deps.settings.find_by_key(REALM_TEAMS_KEY)) return { already: true, moved: [], problems: [] };
    const sq = get_sequelize();
    const column = await sq.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'cliq' AND table_name = 'realms' AND column_name = 'team_list'`,
        { type: QueryTypes.SELECT },
    );
    const result: RealmTeamsFromJsonResult = { already: false, moved: [], problems: [] };
    if (!column.length) {
        await deps.settings.create(REALM_TEAMS_KEY, JSON.stringify({ at: new Date().toISOString(), note: 'no team_list column' }));
        return result;
    }

    const realms = await sq.query<{ id: string; team_list: Entry[] | null }>(
        `SELECT "id", "team_list" FROM cliq."realms" WHERE jsonb_array_length(COALESCE("team_list", '[]'::jsonb)) > 0`,
        { type: QueryTypes.SELECT },
    );
    for (const realm of realms) {
        for (const e of realm.team_list ?? []) {
            const scope = typeof e.scope === 'string' ? e.scope : null;
            const slug = typeof e.slug === 'string' ? e.slug : null;
            const label = `${realm.id} ${scope ?? '?'}/${slug ?? '?'}`;
            if (!slug) { result.problems.push(`${label}: no slug`); continue; }
            const [team] = await sq.query<{ id: string }>(
                `SELECT "id" FROM cliq."teams" WHERE "name" = :slug AND "scope" IS NOT DISTINCT FROM :scope`,
                { type: QueryTypes.SELECT, replacements: { slug, scope } },
            );
            if (!team) { result.problems.push(`${label}: no catalog team`); continue; }
            let version: { id: string; version: string } | null = null;
            if (typeof e.version === 'string' && e.version) {
                const [row] = await sq.query<{ id: string; version: string }>(
                    `SELECT "id", "version" FROM cliq."team_versions" WHERE "team_id" = :team_id AND "version" = :version AND "status" = 'published'`,
                    { type: QueryTypes.SELECT, replacements: { team_id: team.id, version: e.version } },
                );
                version = row ?? null;
                if (!version) { result.problems.push(`${label}: version ${e.version} not found`); continue; }
            } else {
                version = await deps.versions.find_latest_ref(team.id);
                if (!version) { result.problems.push(`${label}: no published version`); continue; }
            }
            await sq.query(
                `INSERT INTO cliq."realm_teams" ("id", "realm_id", "team_id", "version_id", "created_at", "updated_at")
                 VALUES (:id, :realm_id, :team_id, :version_id, now(), now())
                 ON CONFLICT ("realm_id", "team_id") DO NOTHING`,
                { replacements: { id: randomUUID(), realm_id: realm.id, team_id: team.id, version_id: version.id } },
            );
            result.moved.push(`${label}@${version.version}`);
        }
    }

    const report = JSON.stringify({ at: new Date().toISOString(), moved: result.moved.length, problems: result.problems });
    if (result.problems.length) {
        log.error('realm_teams_from_json_incomplete', { moved: result.moved.length, problems: result.problems.slice(0, 50), total: result.problems.length });
        if (await deps.settings.find_by_key(REALM_TEAMS_REPORT_KEY)) await deps.settings.update_by_key(REALM_TEAMS_REPORT_KEY, report);
        else await deps.settings.create(REALM_TEAMS_REPORT_KEY, report);
    } else {
        await deps.settings.create(REALM_TEAMS_KEY, report);
        log.info('realm_teams_from_json_done', { realms: realms.length, moved: result.moved.length });
    }
    return result;
}
