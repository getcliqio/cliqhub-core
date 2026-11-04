/**
 * A realm team's sub-team tree (PLAN-team-bundle S8): resolved from the calls each published version recorded —
 * a pin as written, else the latest published; each row names the version that calls it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The catalog: teams by `scope/name`, versions by team, and each version's recorded calls. */
const TEAMS: Record<string, { id: string }> = {};
const VERSIONS: Array<{ id: string; team_id: string; version: string; latest?: boolean }> = [];
const CALLS: Record<string, string[]> = {};

vi.mock('../../../src/repositories/team_repository.js', () => ({
    TeamRepository: class { find_by_name_and_scope = async (name: string, scope: string) => TEAMS[`${scope}/${name}`] ?? null; },
}));
vi.mock('../../../src/repositories/team_version_repository.js', () => ({
    TeamVersionRepository: class {
        find_current_by_team_and_version = async (team_id: string, version: string) => VERSIONS.find((v) => v.team_id === team_id && v.version === version) ?? null;
        find_latest_ref = async (team_id: string) => VERSIONS.find((v) => v.team_id === team_id && v.latest) ?? null;
    },
}));
vi.mock('../../../src/repositories/team_version_sub_team_repository.js', () => ({
    TeamVersionSubTeamRepository: class {
        list_by_version = async (version_id: string) => (CALLS[version_id] ?? []).map((ref, position) => ({ version_id, position, phase: `p${position}`, ref, team_id: null, pinned_version_id: null, may_call: false }));
    },
}));

import { resolve_realm_tree } from '../../../src/services/realm_team_tree.js';

function team(name: string, ...versions: Array<[string, string[], boolean?]>): void {
    TEAMS[`acme/${name}`] = { id: name };
    for (const [version, calls, latest] of versions) {
        const id = `${name}-${version}`;
        VERSIONS.push({ id, team_id: name, version, latest });
        CALLS[id] = calls;
    }
}
const ROOT = { team_id: 'top', version_id: 'top-1.0.0', scope: 'acme', slug: 'top' };

describe('resolve_realm_tree', () => {
    beforeEach(() => {
        for (const k of Object.keys(TEAMS)) delete TEAMS[k];
        for (const k of Object.keys(CALLS)) delete CALLS[k];
        VERSIONS.length = 0;
    });

    it('a pin resolves to its version, an unpinned call to the latest published; each row names its calling version', async () => {
        team('top', ['1.0.0', ['@acme/mid', '@acme/leaf@1.0.0'], true]);
        team('mid', ['1.0.0', ['@acme/leaf'], true]);
        team('leaf', ['1.0.0', []], ['1.1.0', [], true]);
        expect(await resolve_realm_tree(ROOT)).toEqual([
            { parent_version_id: 'top-1.0.0', ref: '@acme/mid', team_id: 'mid', version_id: 'mid-1.0.0' },
            { parent_version_id: 'mid-1.0.0', ref: '@acme/leaf', team_id: 'leaf', version_id: 'leaf-1.1.0' },
            { parent_version_id: 'top-1.0.0', ref: '@acme/leaf@1.0.0', team_id: 'leaf', version_id: 'leaf-1.0.0' },
        ]);
    });

    it('a team or pin that isn\'t published refuses the tree (sub_team_not_found)', async () => {
        team('top', ['1.0.0', ['@acme/ghost'], true]);
        await expect(resolve_realm_tree(ROOT)).rejects.toMatchObject({ code: 'sub_team_not_found', status: 422, message: expect.stringContaining("isn't published on CliqHub") });
        team('leaf', ['1.0.0', [], true]);
        CALLS['top-1.0.0'] = ['@acme/leaf@9.9.9'];
        await expect(resolve_realm_tree(ROOT)).rejects.toMatchObject({ code: 'sub_team_not_found' });
    });

    it('a cycle refuses the tree', async () => {
        team('top', ['1.0.0', ['@acme/a'], true]);
        team('a', ['1.0.0', ['@acme/b'], true]);
        team('b', ['1.0.0', ['@acme/a'], true]);
        await expect(resolve_realm_tree(ROOT)).rejects.toMatchObject({ code: 'tree_cycle', status: 422 });
    });

    it('a team with no sub-teams has an empty tree', async () => {
        team('top', ['1.0.0', [], true]);
        expect(await resolve_realm_tree(ROOT)).toEqual([]);
    });
});
