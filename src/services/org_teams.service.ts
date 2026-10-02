/**
 * An org's team library: the teams an org has taken on. A team joins the org
 * first, then the org's realms add it to their team lists.
 *
 *   - Teams owned by one of the org's scopes belong to it already; they join
 *     the library the first time a realm adds them.
 *   - Any other team (from the marketplace) joins when someone with
 *     `teams.install` in the org adds it (`orgs/add_team`), or adds it straight
 *     to one of the org's realms (`realms/add_team` adds it to the org too).
 *   - A team leaves the library only when none of the org's realms has it.
 */

import { QueryTypes } from 'sequelize';

import { can_read_team } from '../auth/access.js';
import { require_permission } from '../auth/permissions.js';
import { ApiError } from '../errors/api_error.js';
import { get_sequelize } from '../lib/sequelize.js';
import { OrgTeam, Realm, Scope, Team } from '../models/index.js';
import type { AuthContext } from '../schemas/auth_types.js';

/** Permission to add teams to (and remove them from) an org's library. */
export const ORG_TEAMS_PERMISSION = 'teams.install';

export interface OrgTeamRow {
    team_id: string;
    scope: string | null;
    name: string;
    /** True when one of the org's scopes owns the team. */
    own: boolean;
    added_at: string;
    added_by: string | null;
    /** The org's realms whose team list has the team. */
    realms: Array<{ realm_id: string; slug: string }>;
}

type TeamRef = { team_id?: string; scope?: string | null; slug?: string };

async function find_team(auth: AuthContext, ref: TeamRef) {
    const team = ref.team_id
        ? await Team.findByPk(ref.team_id, { raw: true })
        : await Team.findOne({ where: { name: ref.slug ?? '', scope: ref.scope || null }, raw: true });
    if (!team || !can_read_team(auth, team as never)) throw new ApiError('not_found', 'Team not found', 404);
    return team as unknown as { id: string; name: string; scope: string | null };
}

async function owned_by_org(org_id: string, scope: string | null): Promise<boolean> {
    if (!scope) return false;
    return (await Scope.count({ where: { slug: scope, org_id } })) > 0;
}

async function realms_with(org_id: string, scope: string | null, name: string): Promise<Array<{ realm_id: string; slug: string }>> {
    const rows = await get_sequelize().query<{ id: string; slug: string }>(
        `SELECT r."id", r."slug" FROM cliq."realms" r
          WHERE r."org_id" = $1 AND NOT r."deleted"
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(r."team_list") e
                         WHERE e->>'slug' = $2 AND NULLIF(e->>'scope', '') IS NOT DISTINCT FROM $3)
          ORDER BY r."slug"`,
        { bind: [org_id, name, scope], type: QueryTypes.SELECT },
    );
    return rows.map((r) => ({ realm_id: r.id, slug: r.slug }));
}

export class OrgTeamsService {
    /**
     * The org's library, newest first, with the realms that have each team.
     *
     * @param org_id - Org (route policy: caller is a member)
     */
    static async list(org_id: string): Promise<OrgTeamRow[]> {
        const rows = await get_sequelize().query<{ team_id: string; scope: string | null; name: string; added_at: Date; added_by: string | null; own: boolean }>(
            `SELECT ot."team_id", t."scope", t."name", ot."added_at", u."username" AS "added_by",
                    EXISTS (SELECT 1 FROM cliq."scopes" s WHERE s."slug" = t."scope" AND s."org_id" = ot."org_id") AS "own"
               FROM cliq."org_teams" ot
               JOIN cliq."teams" t ON t."id" = ot."team_id"
               LEFT JOIN cliq."users" u ON u."id" = ot."added_by"
              WHERE ot."org_id" = $1
              ORDER BY ot."added_at" DESC, t."name"`,
            { bind: [org_id], type: QueryTypes.SELECT },
        );
        const realms = await get_sequelize().query<{ id: string; slug: string; team_list: Array<{ scope?: string; slug?: string }> }>(
            `SELECT "id", "slug", "team_list" FROM cliq."realms" WHERE "org_id" = $1 AND NOT "deleted" ORDER BY "slug"`,
            { bind: [org_id], type: QueryTypes.SELECT },
        );
        return rows.map((r) => ({
            team_id: r.team_id, scope: r.scope, name: r.name, own: Boolean(r.own),
            added_at: new Date(r.added_at).toISOString(), added_by: r.added_by,
            realms: realms
                .filter((x) => (x.team_list ?? []).some((e) => e.slug === r.name && (e.scope || null) === r.scope))
                .map((x) => ({ realm_id: x.id, slug: x.slug })),
        }));
    }

    /**
     * Adds a team to the org's library (no-op when it is there already).
     *
     * @param auth - Caller (route policy: `teams.install` in the org)
     * @returns The team and whether this call added it
     * @throws ApiError 404 when the caller cannot see the team
     */
    static async add(auth: AuthContext, org_id: string, ref: TeamRef): Promise<{ team_id: string; scope: string | null; name: string; added: boolean }> {
        const team = await find_team(auth, ref);
        const [, created] = await OrgTeam.findOrCreate({
            where: { org_id, team_id: team.id },
            defaults: { org_id, team_id: team.id, added_by: auth.user?.id ?? null, added_at: new Date() },
        });
        return { team_id: team.id, scope: team.scope, name: team.name, added: created };
    }

    /**
     * Removes a team from the org's library.
     *
     * @throws ApiError 409 `team_in_use` with `details.realms` while any of the org's realms has it
     */
    static async remove(auth: AuthContext, org_id: string, ref: TeamRef): Promise<{ team_id: string; removed: boolean }> {
        const team = await find_team(auth, ref);
        const using = await realms_with(org_id, team.scope, team.name);
        if (using.length) {
            throw new ApiError('team_in_use', `Remove it from ${using.map((r) => r.slug).join(', ')} first`, 409, { realms: using });
        }
        const removed = await OrgTeam.destroy({ where: { org_id, team_id: team.id } });
        return { team_id: team.id, removed: removed > 0 };
    }

    /**
     * Before a realm adds a team: makes sure the team is in the realm's org,
     * adding it when the org owns the team or the caller may add teams to the org.
     *
     * @throws ApiError 403 `team_not_in_org` when the team is not in the org and the caller cannot add it
     */
    static async ensure_for_realm(auth: AuthContext, realm_id: string, scope: string, slug: string): Promise<void> {
        const realm = await Realm.findByPk(realm_id, { attributes: ['org_id'], raw: true }) as { org_id: string | null } | null;
        if (!realm?.org_id) return;
        const team = await Team.findOne({ where: { name: slug, scope: scope || null }, attributes: ['id', 'scope'], raw: true }) as { id: string; scope: string | null } | null;
        // An unknown team is refused by the team list itself.
        if (!team) return;
        if (await OrgTeam.count({ where: { org_id: realm.org_id, team_id: team.id } })) return;
        if (!(await owned_by_org(realm.org_id, team.scope))) {
            try {
                await require_permission(realm.org_id, auth.user!.id, ORG_TEAMS_PERMISSION, { site_role: auth.user!.role });
            } catch {
                throw new ApiError('team_not_in_org', `@${scope}/${slug} isn't in this org yet. Ask someone who can add teams to the org to add it first.`, 403, { scope, slug });
            }
        }
        await OrgTeam.findOrCreate({
            where: { org_id: realm.org_id, team_id: team.id },
            defaults: { org_id: realm.org_id, team_id: team.id, added_by: auth.user?.id ?? null, added_at: new Date() },
        });
    }
}
