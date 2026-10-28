/**
 * One time (Oct 2026, PLAN-team-visibility §5.3): scopes become namespaces of an org with members, and
 * visibility lives on the team.
 *
 *   1. `@cliq` belongs to the `cliq` org: its org, owner and that org's default scope are filled in when
 *      empty ({@link attach_cliq_scope}). If `@cliq` already belongs to another org, or the `cliq` org's
 *      default scope is a different scope, nothing runs: the plan owner decides.
 *   2. Every scope but the default one belongs to an org; any that doesn't stops the migration (logged
 *      with its slug) instead of guessing an org.
 *   3. Nobody loses a private team they read today: until now any member of a scope's org read its
 *      private teams; from now only the scope's members do. For every scope holding private teams, each
 *      active member of its org who isn't an owner or admin (they are members anyway) and isn't assigned
 *      yet is assigned (plan owner, 2026-10-28).
 *   4. `org_teams` keeps only teams an org added from another org's scope: rows for its own teams and for
 *      the default scope's are deleted (both are on every Teams list without a row, §3.6).
 *   5. `scopes.visibility`, `scopes.scope_type` and `teams.scope_type` are dropped.
 *
 * Steps 3–5 run in one transaction; the key is recorded once they succeed. Safe to repeat until then.
 */

import { QueryTypes, type Sequelize, type Transaction } from 'sequelize';

import { get_logger } from '../../lib/log.js';

const log = get_logger('db.migrate');

/** `cliq.settings` key marking this migration as done. */
export const TEAM_VISIBILITY_MIGRATION_KEY = 'migrate.team_visibility_2026_10';

/** Why {@link attach_cliq_scope} left `@cliq` alone, or null when it belongs to the `cliq` org (or there is none yet). */
type AttachProblem = string | null;

/**
 * Fill in `@cliq`'s org (the `cliq` org), owner (that org's owner) and the org's default scope, each
 * only when empty. Does nothing when there is no `cliq` org yet (a fresh install). Also used by the seed.
 *
 * @returns a reason when `@cliq` belongs to another org or the `cliq` org has another default scope
 */
export async function attach_cliq_scope(sq: Sequelize, transaction?: Transaction): Promise<AttachProblem> {
    const [row] = await sq.query<{ scope_id: string; scope_org: string | null; org_id: string | null; org_default: string | null }>(
        `SELECT s."id" AS scope_id, s."org_id" AS scope_org, o."id" AS org_id, o."default_scope_id" AS org_default
           FROM cliq."scopes" s LEFT JOIN cliq."orgs" o ON o."slug" = 'cliq'
          WHERE s."slug" = 'cliq'`,
        { type: QueryTypes.SELECT, transaction },
    );
    if (!row?.org_id) return null;
    if (row.scope_org && row.scope_org !== row.org_id) return '@cliq belongs to another org';
    if (row.org_default && row.org_default !== row.scope_id) return "the cliq org's default scope is another scope";
    await sq.query(
        `UPDATE cliq."scopes" s SET "org_id" = COALESCE(s."org_id", o."id"), "owner_id" = COALESCE(s."owner_id", o."owner_id")
           FROM cliq."orgs" o WHERE o."slug" = 'cliq' AND s."slug" = 'cliq'`,
        { transaction },
    );
    await sq.query(
        `UPDATE cliq."orgs" SET "default_scope_id" = :scope_id WHERE "slug" = 'cliq' AND "default_scope_id" IS NULL`,
        { replacements: { scope_id: row.scope_id }, transaction },
    );
    return null;
}

/** Runs the migration described in the module header. Never throws; a refusal or failure is logged. */
export async function migrate_team_visibility(sq: Sequelize): Promise<void> {
    try {
        const [tables] = await sq.query(
            `SELECT to_regclass('cliq.settings') AS s, to_regclass('cliq.scope_members') AS m, to_regclass('cliq.org_teams') AS t`,
            { type: QueryTypes.SELECT },
        ) as Array<{ s: string | null; m: string | null; t: string | null }>;
        if (!tables?.s || !tables?.m || !tables?.t) {
            log.info('team_visibility_deferred', { reason: 'tables not created yet' });
            return;
        }
        const done = await sq.query(`SELECT 1 FROM cliq."settings" WHERE "key" = :key`,
            { replacements: { key: TEAM_VISIBILITY_MIGRATION_KEY }, type: QueryTypes.SELECT });
        if (done.length > 0) return;

        const problem = await attach_cliq_scope(sq);
        if (problem) {
            log.error('team_visibility_refused', { reason: problem });
            return;
        }
        const orgless = await sq.query<{ slug: string }>(
            `SELECT "slug" FROM cliq."scopes" WHERE "org_id" IS NULL AND "is_default" = 0 ORDER BY "slug"`,
            { type: QueryTypes.SELECT },
        );
        if (orgless.length > 0) {
            log.error('team_visibility_refused', { reason: 'scopes with no org', scopes: orgless.map((s) => s.slug) });
            return;
        }

        const result = await sq.transaction(async (transaction) => {
            const assigned = await sq.query(
                `INSERT INTO cliq."scope_members" ("scope_id", "user_id")
                 SELECT DISTINCT s."id", m."user_id"
                   FROM cliq."scopes" s
                   JOIN cliq."org_members" m ON m."org_id" = s."org_id" AND m."status" = 'active' AND m."deleted_at" IS NULL
                   LEFT JOIN cliq."org_roles" r ON r."id" = m."role_id"
                  WHERE EXISTS (SELECT 1 FROM cliq."teams" t WHERE t."scope" = s."slug" AND t."visibility" = 'private')
                    AND NOT COALESCE(r."is_system", false) AND COALESCE(r."slug", '') <> 'admin'
                 ON CONFLICT ("scope_id", "user_id") DO NOTHING
                 RETURNING "scope_id"`,
                { type: QueryTypes.SELECT, transaction },
            );
            const removed = await sq.query(
                `DELETE FROM cliq."org_teams" ot
                  USING cliq."teams" t, cliq."scopes" s
                  WHERE t."id" = ot."team_id" AND s."slug" = t."scope" AND (s."org_id" = ot."org_id" OR s."is_default" = 1)
                 RETURNING ot."team_id"`,
                { type: QueryTypes.SELECT, transaction },
            );
            await sq.query(`ALTER TABLE cliq."scopes" DROP COLUMN IF EXISTS "visibility"`, { transaction });
            await sq.query(`ALTER TABLE cliq."scopes" DROP COLUMN IF EXISTS "scope_type"`, { transaction });
            await sq.query(`ALTER TABLE cliq."teams" DROP COLUMN IF EXISTS "scope_type"`, { transaction });
            await sq.query(
                `INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW()) ON CONFLICT ("key") DO NOTHING`,
                { replacements: { key: TEAM_VISIBILITY_MIGRATION_KEY, value: new Date().toISOString() }, transaction },
            );
            return { scope_members_added: assigned.length, org_teams_removed: removed.length };
        });
        log.info('team_visibility_migrated', result);
    } catch (err) {
        log.error('team_visibility_migration_failed', { error: (err as Error)?.message ?? String(err) });
    }
}
