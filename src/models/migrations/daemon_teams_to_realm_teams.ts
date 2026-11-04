/**
 * Once, after the realm lists have moved to `realm_teams` (PLAN-team-bundle S4.2): every `daemon_teams` row is
 * tied to its catalog team, and each installed row to the realm team it belongs to.
 *
 * 1. Two installed rows of one team on one daemon (the old index allowed one per version): the newest stays, the
 *    others are marked uninstalled.
 * 2. Every row (installed or not) gets its catalog `team_id`, matched by scope and name.
 * 3. Each installed row whose team is on its daemon's realm gets that `realm_team_id`, and the `version_id` of the
 *    version it has (when that version is in the catalog).
 * 4. Installed rows still without a realm team (a team not on the realm, a local team, no catalog team) are marked
 *    uninstalled: Core records realm teams only. They are kept, so their runs keep their team.
 * 5. The CHECK that an installed row has its realm team is added.
 *
 * Runs only after `realm_teams_from_json` has recorded its pass ({@link REALM_TEAMS_KEY}): with the realm lists
 * not moved yet, step 4 would uninstall every row. Recorded under {@link DAEMON_TEAMS_KEY}.
 */
import { QueryTypes } from 'sequelize';
import { get_logger } from '../../lib/log.js';
import { get_sequelize } from '../../lib/sequelize.js';
import type { SettingsRepository } from '../../repositories/settings_repository.js';
import { REALM_TEAMS_KEY } from './realm_teams_from_json.js';

const log = get_logger('db.migrate');

/** `cliq.settings` key recording the pass. */
export const DAEMON_TEAMS_KEY = 'migrate.daemon_teams_to_realm_teams_2026_11';

/** What a pass did. */
export interface DaemonTeamsToRealmTeamsResult {
    already: boolean;
    /** The realm lists haven't moved yet: nothing was done. */
    waiting: boolean;
    duplicates_uninstalled: number;
    linked: number;
    uninstalled: number;
}

/** Tie `daemon_teams` rows to their catalog team and realm team (see the file header). */
export async function daemon_teams_to_realm_teams(deps: { settings: SettingsRepository }): Promise<DaemonTeamsToRealmTeamsResult> {
    const none = { duplicates_uninstalled: 0, linked: 0, uninstalled: 0 };
    if (await deps.settings.find_by_key(DAEMON_TEAMS_KEY)) return { already: true, waiting: false, ...none };
    if (!(await deps.settings.find_by_key(REALM_TEAMS_KEY))) {
        log.warn('daemon_teams_to_realm_teams_waiting', { reason: 'realm lists not moved yet' });
        return { already: false, waiting: true, ...none };
    }
    const sq = get_sequelize();
    const now = Date.now();

    const result = await sq.transaction(async (t) => {
        const q = (sql: string) => sq.query(sql, { transaction: t, replacements: { now } });
        const n = async (sql: string) =>
            ((await sq.query(`${sql} RETURNING 1`, { type: QueryTypes.SELECT, transaction: t, replacements: { now } })) as unknown[]).length;

        // The catalog team of each row, by scope and name.
        const catalog = `
            SELECT dt."id" AS "row_id", te."id" AS "team_id"
            FROM cliq."daemon_teams" dt
            JOIN cliq."scopes" s ON s."id"::text = dt."scope_id"::text
            JOIN cliq."teams" te ON te."scope" = s."slug" AND te."name" = dt."slug"`;

        // 1. Two installed rows of one team on one daemon: the newest stays.
        const duplicates_uninstalled = await n(`
            UPDATE cliq."daemon_teams" dt SET "uninstalled_at" = :now, "updated_at" = :now
            WHERE dt."uninstalled_at" IS NULL AND dt."daemon_id" IS NOT NULL AND EXISTS (
                SELECT 1 FROM cliq."daemon_teams" o
                WHERE o."daemon_id" = dt."daemon_id" AND o."scope_id" = dt."scope_id" AND o."slug" = dt."slug"
                  AND o."uninstalled_at" IS NULL
                  AND (o."updated_at" > dt."updated_at" OR (o."updated_at" = dt."updated_at" AND o."id" > dt."id")))`);

        // 2. Every row's catalog team.
        await q(`
            UPDATE cliq."daemon_teams" dt SET "team_id" = c."team_id"
            FROM (${catalog}) c WHERE c."row_id" = dt."id" AND dt."team_id" IS NULL`);

        // 3. Installed rows on their daemon's realm list: that realm team, and the version they have.
        const linked = await n(`
            UPDATE cliq."daemon_teams" dt SET "realm_team_id" = m."realm_team_id", "version_id" = m."version_id"
            FROM (
                SELECT DISTINCT ON (dt2."id") dt2."id" AS "row_id", rt."id" AS "realm_team_id", v."id" AS "version_id"
                FROM cliq."daemon_teams" dt2
                JOIN cliq."realm_members" rm ON rm."member_type" = 'daemon' AND rm."member_id"::text = dt2."daemon_id"::text
                    AND rm."deleted_at" IS NULL
                JOIN cliq."realm_teams" rt ON rt."realm_id"::text = rm."realm_id"::text AND rt."team_id" = dt2."team_id"
                LEFT JOIN cliq."team_versions" v ON v."team_id" = dt2."team_id" AND v."version" = dt2."version" AND v."status" = 'published'
                WHERE dt2."uninstalled_at" IS NULL AND dt2."realm_team_id" IS NULL
                ORDER BY dt2."id", rm."created_at" DESC
            ) m WHERE m."row_id" = dt."id"`);

        // 4. Installed rows still without a realm team: Core records realm teams only.
        const uninstalled = await n(`
            UPDATE cliq."daemon_teams" SET "uninstalled_at" = :now, "updated_at" = :now
            WHERE "uninstalled_at" IS NULL AND "realm_team_id" IS NULL`);

        // 5. From now on an installed row has its realm team.
        await q(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daemon_teams_live_has_realm_team') THEN
                    ALTER TABLE cliq."daemon_teams" ADD CONSTRAINT "daemon_teams_live_has_realm_team"
                        CHECK ("uninstalled_at" IS NOT NULL OR "realm_team_id" IS NOT NULL OR "via_realm_team_id" IS NOT NULL);
                END IF;
            END $$`);
        return { duplicates_uninstalled, linked, uninstalled };
    });

    await deps.settings.create(DAEMON_TEAMS_KEY, JSON.stringify({ at: new Date().toISOString(), ...result }));
    log.info('daemon_teams_to_realm_teams_done', result);
    return { already: false, waiting: false, ...result };
}
