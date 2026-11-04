/**
 * A realm team's sub-team tree (PLAN-team-bundle S8), resolved once when the realm adds or moves the team: every
 * call recorded at publish (`team_version_sub_teams`), at any depth, mapped to a published version — the pinned one,
 * else the latest published at that moment. Every daemon in the realm then installs exactly these versions.
 * The SDK's walk enforces the limits: no cycles, depth ≤ 8, ≤ 64 (team, version) pairs.
 */

import { pinned_version, resolve_tree, TeamTreeError, type ParsedTeamRef } from '@getcliqio/cliq-sdk';

import { ApiError } from '../errors/api_error.js';
import type { RealmTeamTreeRow } from '../repositories/realm_team_repository.js';
import { TeamRepository } from '../repositories/team_repository.js';
import { TeamVersionRepository } from '../repositories/team_version_repository.js';
import { TeamVersionSubTeamRepository, type SubTeamRow } from '../repositories/team_version_sub_team_repository.js';

/** One node as the walk sees it: a published version and the calls it recorded. */
interface Node {
    version_id: string;
    calls: SubTeamRow[];
}

/** The node's id in the walk: team and version, so two versions of one team are two nodes. */
const node_id = (team_id: string, version_id: string): string => `${team_id}|${version_id}`;

/**
 * Resolve the tree under a team version.
 *
 * @param root - The realm team: its team, version and name.
 * @returns One row per call, parents before their children.
 * @throws ApiError 422 `sub_team_not_found` when a called team (or pinned version) isn't published;
 *   `tree_cycle` / `tree_too_deep` / `tree_too_large` when the tree breaks a limit.
 */
export async function resolve_realm_tree(root: { team_id: string; version_id: string; scope: string; slug: string }): Promise<RealmTeamTreeRow[]> {
    const teams = new TeamRepository();
    const versions = new TeamVersionRepository();
    const sub_teams = new TeamVersionSubTeamRepository();
    const node = async (version_id: string): Promise<Node> => ({ version_id, calls: await sub_teams.list_by_version(version_id) });

    let tree;
    try {
        tree = await resolve_tree<Node>(
            { team_id: node_id(root.team_id, root.version_id), ref: { scope: root.scope, slug: root.slug }, manifest: await node(root.version_id) },
            async (ref: ParsedTeamRef) => {
                const team = await teams.find_by_name_and_scope(ref.slug, ref.scope);
                if (!team) return null;
                const pin = pinned_version(ref);
                const found = pin ? await versions.find_current_by_team_and_version(team.id, pin) : await versions.find_latest_ref(team.id);
                if (!found?.version) return null;
                return { team_id: node_id(team.id, found.id), version: found.version, manifest: await node(found.id) };
            },
            { phases_of: (n) => n.calls.map((c) => ({ name: c.phase, type: 'team', team: c.ref })) },
        );
    } catch (err) {
        if (!(err instanceof TeamTreeError)) throw err;
        const code = err.code === 'not_found' ? 'sub_team_not_found' : err.code;
        throw new ApiError(code, `@${root.scope}/${root.slug}: ${err.message.replace('is not in the catalog', "isn't published on CliqHub")}`, 422);
    }
    // Each node's ids are (team|version): the parent's carries the calling version.
    return tree.nodes.map((n) => {
        const [team_id, version_id] = n.team_id.split('|');
        return { parent_version_id: n.parent_team_id.split('|')[1], ref: ref_text(n.ref), team_id, version_id };
    });
}

/** A ref as recorded: `@scope/slug` or `@scope/slug@version`. */
function ref_text(ref: ParsedTeamRef): string {
    return `@${ref.scope}/${ref.slug}${ref.version ? '@' + ref.version : ''}`;
}
