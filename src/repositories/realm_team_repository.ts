import { randomUUID } from 'node:crypto';
import { QueryTypes, type Transaction } from 'sequelize';
import { get_sequelize } from '../lib/sequelize.js';

/** A team on a realm, with its names (PLAN-team-bundle S4.1). */
export interface RealmTeamRow {
    id: string;
    realm_id: string;
    team_id: string;
    version_id: string;
    /** `teams.scope` / `teams.name` / `team_versions.version`: labels, read through the ids. */
    scope: string;
    slug: string;
    version: string;
}

/** The SELECT every read shares: the row and the names its ids point at. */
const ROWS = `
    SELECT rt."id", rt."realm_id", rt."team_id", rt."version_id",
           t."scope" AS "scope", t."name" AS "slug", v."version" AS "version"
    FROM cliq."realm_teams" rt
    JOIN cliq."teams" t ON t."id" = rt."team_id"
    JOIN cliq."team_versions" v ON v."id" = rt."version_id" AND v."status" = 'published'`;

/**
 * `cliq.realm_teams`: the teams each realm runs, one version each. Used only by `RealmTeamListService`, which every
 * reader of a realm's teams goes through (a guard test enforces it). SQL only, so importing it loads no model.
 */
export class RealmTeamRepository {

    /** A realm's teams, by name. */
    async list(realm_id: string): Promise<RealmTeamRow[]> {
        return get_sequelize().query<RealmTeamRow>(`${ROWS} WHERE rt."realm_id" = :realm_id ORDER BY t."scope", t."name"`,
            { type: QueryTypes.SELECT, replacements: { realm_id } });
    }

    /** Several realms' teams. */
    async list_for(realm_ids: string[]): Promise<RealmTeamRow[]> {
        if (!realm_ids.length) return [];
        return get_sequelize().query<RealmTeamRow>(`${ROWS} WHERE rt."realm_id" IN (:realm_ids) ORDER BY rt."realm_id", t."scope", t."name"`,
            { type: QueryTypes.SELECT, replacements: { realm_ids } });
    }

    /** One team on one realm, or null. */
    async find(realm_id: string, team_id: string): Promise<RealmTeamRow | null> {
        const rows = await get_sequelize().query<RealmTeamRow>(`${ROWS} WHERE rt."realm_id" = :realm_id AND rt."team_id" = :team_id`,
            { type: QueryTypes.SELECT, replacements: { realm_id, team_id } });
        return rows[0] ?? null;
    }

    /** The realms that run a team (optionally only an org's). */
    async realm_ids_with(team_id: string, org_id?: string): Promise<string[]> {
        const rows = await get_sequelize().query<{ realm_id: string }>(
            `SELECT rt."realm_id" FROM cliq."realm_teams" rt
             ${org_id ? 'JOIN cliq."realms" r ON r."id" = rt."realm_id" AND r."org_id" = :org_id' : ''}
             WHERE rt."team_id" = :team_id`,
            { type: QueryTypes.SELECT, replacements: { team_id, ...(org_id ? { org_id } : {}) } },
        );
        return rows.map((r) => r.realm_id);
    }

    /** Put a team on a realm at a version, or move it to that version. */
    async put(realm_id: string, team_id: string, version_id: string, transaction?: Transaction): Promise<void> {
        await get_sequelize().query(
            `INSERT INTO cliq."realm_teams" ("id", "realm_id", "team_id", "version_id", "created_at", "updated_at")
             VALUES (:id, :realm_id, :team_id, :version_id, now(), now())
             ON CONFLICT ("realm_id", "team_id") DO UPDATE SET "version_id" = EXCLUDED."version_id", "updated_at" = now()`,
            { replacements: { id: randomUUID(), realm_id, team_id, version_id }, transaction },
        );
    }

    /** Take a team off a realm; false when it wasn't on it. */
    async take_off(realm_id: string, team_id: string): Promise<boolean> {
        const rows = await get_sequelize().query<{ id: string }>(
            `DELETE FROM cliq."realm_teams" WHERE "realm_id" = :realm_id AND "team_id" = :team_id RETURNING "id"`,
            { type: QueryTypes.SELECT, replacements: { realm_id, team_id } },
        );
        return rows.length > 0;
    }

    /** Take a team off the given realms. */
    async take_off_realms(team_id: string, realm_ids: string[], transaction?: Transaction): Promise<void> {
        if (!realm_ids.length) return;
        await get_sequelize().query(`DELETE FROM cliq."realm_teams" WHERE "team_id" = :team_id AND "realm_id" IN (:realm_ids)`,
            { replacements: { team_id, realm_ids }, transaction });
    }

    /** Take a team off every realm: the realms it was on. */
    async take_off_everywhere(team_id: string): Promise<string[]> {
        const realm_ids = await this.realm_ids_with(team_id);
        if (realm_ids.length) await get_sequelize().query(`DELETE FROM cliq."realm_teams" WHERE "team_id" = :team_id`, { replacements: { team_id } });
        return realm_ids;
    }
}
