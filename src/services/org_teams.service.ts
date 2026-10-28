/**
 * An org's Teams list (PLAN-team-visibility §3.6) — a view of three parts, only the last one stored:
 *
 *   - own:   the published teams in the org's scopes;
 *   - cliq:  the published public teams in the default scope (`@cliq`), on every org's list;
 *   - added: teams from other orgs' scopes the org chose (`cliq.org_teams`), with `orgs/add_team`
 *            (`teams.install` in the org) and `orgs/remove_team`.
 *
 * Own and `@cliq` teams can't be added or removed. A realm installs only from its org's list
 * (`realms/add_team` checks it; it never adds to the list).
 */

import { QueryTypes } from 'sequelize';

import { can_read_team, type TeamAccess } from '../auth/access.js';
import { ApiError } from '../errors/api_error.js';
import { get_sequelize } from '../lib/sequelize.js';
import { OrgTeam, Realm, Scope, Team } from '../models/index.js';
import type { AuthContext } from '../schemas/auth_types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Permission to add teams to (and remove them from) an org's Teams list. */
export const ORG_TEAMS_PERMISSION = 'teams.install';

/** Why a team is on an org's Teams list. */
export type OrgTeamKind = 'own' | 'cliq' | 'added';

export interface OrgTeamRow {
    team_id: string;
    scope: string | null;
    name: string;
    /** own: in one of the org's scopes; cliq: a default-scope team; added: chosen by the org. */
    kind: OrgTeamKind;
    /** True when one of the org's scopes owns the team (`kind === 'own'`). */
    own: boolean;
    /** When it was added (added teams only). */
    added_at: string | null;
    /** Who added it (added teams only). */
    added_by: string | null;
    /** The org's realms whose team list has the team. */
    realms: Array<{ realm_id: string; slug: string }>;
}

type TeamRef = { team_id?: string; scope?: string | null; slug?: string };
type TeamRow = { id: string; name: string; scope: string | null } & TeamAccess & { listed: number };

async function find_team(ref: TeamRef): Promise<TeamRow | null> {
    const team = ref.team_id
        ? await Team.findByPk(ref.team_id, { raw: true })
        : await Team.findOne({ where: { name: ref.slug ?? '', scope: ref.scope || null }, raw: true });
    return team as unknown as TeamRow | null;
}

/** Whether `team` is on the list without a row: in one of the org's scopes, or a public default-scope team. */
async function derived_kind(org_id: string, team: { scope: string | null; visibility: string }): Promise<'own' | 'cliq' | null> {
    if (!team.scope || team.visibility === 'draft') return null;
    const scope = await Scope.findOne({ where: { slug: team.scope }, attributes: ['org_id', 'is_default'], raw: true }) as { org_id: string | null; is_default: number } | null;
    if (!scope) return null;
    if (scope.org_id === org_id) return 'own';
    if (scope.is_default === 1 && team.visibility === 'public') return 'cliq';
    return null;
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
     * The org's Teams list — own, `@cliq` and added teams — each one the caller can see, with the
     * realms that have it. Own teams first, then `@cliq`'s, then added ones (newest first).
     *
     * @param org_id - Org (route policy: caller is a member)
     */
    static async list(auth: AuthContext, org_id: string): Promise<OrgTeamRow[]> {
        const rows = await get_sequelize().query<{
            team_id: string; scope: string | null; name: string; kind: OrgTeamKind;
            visibility: TeamAccess['visibility']; author_id: string | null; listed: number;
            added_at: Date | null; added_by: string | null;
        }>(
            `SELECT t."id" AS "team_id", t."scope", t."name", t."visibility", t."author_id", t."listed", x."kind", x."added_at", x."added_by"
               FROM (
                    SELECT t."id", 'own' AS "kind", NULL::timestamptz AS "added_at", NULL AS "added_by", 0 AS "ord"
                      FROM cliq."teams" t JOIN cliq."scopes" s ON s."slug" = t."scope"
                     WHERE s."org_id" = $1 AND t."visibility" <> 'draft'
                    UNION ALL
                    SELECT t."id", 'cliq', NULL, NULL, 1
                      FROM cliq."teams" t JOIN cliq."scopes" s ON s."slug" = t."scope"
                     WHERE s."is_default" = 1 AND s."org_id" IS DISTINCT FROM $1 AND t."visibility" = 'public'
                    UNION ALL
                    SELECT ot."team_id", 'added', ot."added_at", u."username", 2
                      FROM cliq."org_teams" ot LEFT JOIN cliq."users" u ON u."id" = ot."added_by"
                     WHERE ot."org_id" = $1
               ) x
               JOIN cliq."teams" t ON t."id" = x."id"
              ORDER BY x."ord", x."added_at" DESC NULLS LAST, t."name"`,
            { bind: [org_id], type: QueryTypes.SELECT },
        );
        const realms = await get_sequelize().query<{ id: string; slug: string; team_list: Array<{ scope?: string; slug?: string }> }>(
            `SELECT "id", "slug", "team_list" FROM cliq."realms" WHERE "org_id" = $1 AND NOT "deleted" ORDER BY "slug"`,
            { bind: [org_id], type: QueryTypes.SELECT },
        );
        const seen = new Set<string>();
        return rows
            .filter((r) => !seen.has(r.team_id) && seen.add(r.team_id) && can_read_team(auth, r))
            .map((r) => ({
                team_id: r.team_id, scope: r.scope, name: r.name, kind: r.kind, own: r.kind === 'own',
                added_at: r.added_at ? new Date(r.added_at).toISOString() : null, added_by: r.added_by,
                realms: realms
                    .filter((x) => (x.team_list ?? []).some((e) => e.slug === r.name && (e.scope || null) === r.scope))
                    .map((x) => ({ realm_id: x.id, slug: x.slug })),
            }));
    }

    /**
     * Adds a team from another org's scope to the org's Teams list (no-op when it is there already).
     *
     * @param auth - Caller (route policy: `teams.install` in the org)
     * @returns The team and whether this call added it
     * @throws ApiError 404 when the caller cannot see the team; 422 for an own or `@cliq` team (always on the list)
     */
    static async add(auth: AuthContext, org_id: string, ref: TeamRef): Promise<{ team_id: string; scope: string | null; name: string; added: boolean }> {
        const team = await find_team(ref);
        if (!team || !can_read_team(auth, team)) throw new ApiError('not_found', 'Team not found', 404);
        if (await derived_kind(org_id, team)) {
            throw new ApiError('invalid_params', `@${team.scope}/${team.name} is already on the Teams list`, 422);
        }
        const [, created] = await OrgTeam.findOrCreate({
            where: { org_id, team_id: team.id },
            defaults: { org_id, team_id: team.id, added_by: auth.user?.id ?? null, added_at: new Date() },
        });
        return { team_id: team.id, scope: team.scope, name: team.name, added: created };
    }

    /**
     * Removes an added team from the org's Teams list. A team the org added stays removable even if
     * it was made private since.
     *
     * @throws ApiError 409 `team_in_use` with `details.realms` while any of the org's realms has it;
     *   422 for an own or `@cliq` team; 404 for a team the org didn't add and the caller can't see
     */
    static async remove(auth: AuthContext, org_id: string, ref: TeamRef): Promise<{ team_id: string; removed: boolean }> {
        const team = await find_team(ref);
        const added = team ? await OrgTeam.count({ where: { org_id, team_id: team.id } }) > 0 : false;
        if (!team || (!added && !can_read_team(auth, team))) throw new ApiError('not_found', 'Team not found', 404);
        if (await derived_kind(org_id, team)) {
            throw new ApiError('invalid_params', `@${team.scope}/${team.name} is always on the Teams list; it can't be removed`, 422);
        }
        const using = await realms_with(org_id, team.scope, team.name);
        if (using.length) {
            throw new ApiError('team_in_use', `Remove it from ${using.map((r) => r.slug).join(', ')} first`, 409, { realms: using });
        }
        const removed = await OrgTeam.destroy({ where: { org_id, team_id: team.id } });
        return { team_id: team.id, removed: removed > 0 };
    }

    /**
     * Before a fleet install (`teams/install`): the caller must see the catalog team, unless the
     * realm already has it (PLAN-team-visibility §3.4). A team id that isn't in the catalog (a
     * daemon-local team) is left to the install itself.
     *
     * @param team_id - `scope/name` or a catalog team id
     * @throws ApiError 404 when the caller cannot see the team
     */
    static async assert_can_install(auth: AuthContext | undefined, team_id: string, realm_id?: string): Promise<void> {
        const [scope, name] = team_id.includes('/') ? team_id.split('/') : [undefined, undefined];
        const team = (name
            ? await Team.findOne({ where: { name, scope: scope || null }, raw: true })
            : UUID_RE.test(team_id) ? await Team.findByPk(team_id, { raw: true }) : null) as unknown as TeamRow | null;
        if (!team) return;
        if (realm_id) {
            const realm = await Realm.findByPk(realm_id, { attributes: ['team_list'], raw: true }) as { team_list: Array<{ scope?: string; slug?: string }> | null } | null;
            if ((realm?.team_list ?? []).some((e) => e.slug === team.name && (e.scope || null) === team.scope)) return;
        }
        if (!can_read_team(auth, team)) throw new ApiError('not_found', 'Team not found', 404);
    }

    /**
     * Before a realm adds a team (or moves it to another version): the team must be on the realm's
     * org's Teams list, and the caller must see it unless the realm already has it (a team made
     * private keeps its realms). Never adds to the list (PLAN-team-visibility §3.4).
     *
     * @throws ApiError 404 when the caller can't see the team; 403 `team_not_in_org` when it isn't on the list
     */
    static async ensure_for_realm(auth: AuthContext, realm_id: string, scope: string, slug: string): Promise<void> {
        const realm = await Realm.findByPk(realm_id, { attributes: ['org_id', 'team_list'], raw: true }) as { org_id: string | null; team_list: Array<{ scope?: string; slug?: string }> | null } | null;
        const team = await find_team({ scope, slug });
        // An unknown team is refused by the team list itself.
        if (!team) return;
        const on_realm = (realm?.team_list ?? []).some((e) => e.slug === slug && (e.scope || null) === (scope || null));
        if (!on_realm && !can_read_team(auth, team)) throw new ApiError('not_found', 'Team not found', 404);
        if (!realm?.org_id) return;
        if (await derived_kind(realm.org_id, team)) return;
        if (await OrgTeam.count({ where: { org_id: realm.org_id, team_id: team.id } })) return;
        throw new ApiError('team_not_in_org', `@${scope}/${slug} isn't on this org's Teams list. Add it there first (orgs/add_team).`, 403, { scope, slug });
    }
}
