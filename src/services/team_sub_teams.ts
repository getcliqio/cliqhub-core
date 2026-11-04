/**
 * The sub-teams a team version calls (PLAN-team-bundle S8), worked out at publish from its team.yml: each
 * `type: team` / `map` phase's `team:` (with a pinned `@version` or not) and each entry of a dynamic map's `teams:`.
 * A pinned version must exist, be published and not withdrawn, and be visible to the publisher; an unpinned ref may
 * name a team not on CliqHub yet (it is resolved when a realm installs the team).
 */

import { allowed_teams, format_team_ref, is_dynamic_team_ref, phase_ref, pinned_version, TeamTreeError, type ParsedTeamRef, type TreePhase } from '@getcliqio/cliq-sdk';

import { can_view_team } from '../auth/access.js';
import { ApiError } from '../errors/api_error.js';
import type { AuthContext } from '../schemas/auth_types.js';
import type { TeamRepository } from '../repositories/team_repository.js';
import type { TeamVersionRepository } from '../repositories/team_version_repository.js';
import type { SubTeamRow } from '../repositories/team_version_sub_team_repository.js';

/** One call as written: the phase, the ref, and whether it comes from a `teams:` list. */
interface Call {
    phase: string;
    ref: ParsedTeamRef;
    may_call: boolean;
}

/**
 * The calls in a team.yml's phases, in order.
 *
 * @param phases - The team.yml's `phases` (as parsed).
 * @throws ApiError `invalid_package` for a `team:` or `teams:` entry that isn't a team ref.
 */
export function sub_team_calls(phases: unknown): Call[] {
    const calls: Call[] = [];
    for (const raw of Array.isArray(phases) ? phases : []) {
        const phase = raw as TreePhase;
        if (!phase || (phase.type !== 'team' && phase.type !== 'map') || typeof phase.team !== 'string') continue;
        try {
            if (!is_dynamic_team_ref(phase.team)) {
                calls.push({ phase: phase.name, ref: phase_ref(phase), may_call: false });
                continue;
            }
            for (const ref of allowed_teams(phase) ?? []) calls.push({ phase: phase.name, ref, may_call: true });
        } catch (err) {
            if (err instanceof TeamTreeError) throw new ApiError('invalid_package', err.message, 422);
            throw err;
        }
    }
    return calls;
}

/**
 * The rows to record for a version being published: each call with the team it names (when on CliqHub) and its
 * pinned version.
 *
 * @param auth - The publisher (a pinned team must be visible to them).
 * @param version_id - The version being published.
 * @param phases - Its team.yml's phases.
 * @param repos - Team and version lookups.
 * @throws ApiError `sub_team_version_not_found` (422) for a pinned version that doesn't exist, is withdrawn, or
 *   belongs to a team the publisher can't see.
 */
export async function sub_team_rows(
    auth: AuthContext,
    version_id: string,
    phases: unknown,
    repos: { teams: Pick<TeamRepository, 'find_by_name_and_scope'>; versions: Pick<TeamVersionRepository, 'find_by_team_and_version'> },
): Promise<SubTeamRow[]> {
    const rows: SubTeamRow[] = [];
    for (const [position, call] of sub_team_calls(phases).entries()) {
        const team = await repos.teams.find_by_name_and_scope(call.ref.slug, call.ref.scope);
        const visible = team && can_view_team(auth, team) ? team : null;
        const pin = pinned_version(call.ref);
        let pinned_version_id: string | null = null;
        if (pin) {
            const version = visible ? await repos.versions.find_by_team_and_version(visible.id, pin) : null;
            if (!version || version.withdrawn_at) {
                throw new ApiError(
                    'sub_team_version_not_found',
                    `Phase '${call.phase}' calls ${format_team_ref(call.ref)}, which isn't a published version you can see on CliqHub: publish it first, or call another version`,
                    422,
                );
            }
            pinned_version_id = version.id;
        }
        rows.push({
            version_id, position, phase: call.phase, ref: format_team_ref(call.ref),
            team_id: visible?.id ?? null, pinned_version_id, may_call: call.may_call,
        });
    }
    return rows;
}
