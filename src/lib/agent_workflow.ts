/**
 * AgentWorkflow — static helpers for parsing, validating, and querying agent usage.
 *
 * `extract_agents` / `parse_ref` — pull agent identifiers out of workflow JSON.
 * `validate_for_dispatch` — checks every agent ref in a manifest against the catalog.
 * `find_teams` — DB query: which teams reference a given agent name?
 * `build_usage` — transform pre-fetched teams/versions/realms into an agent→usage map.
 * `find_org_usage` — full DB-backed query that returns the usage map for an org.
 *
 * Standalone exports at the bottom shadow each class method so callers can import
 * named functions (making them mockable in tests without class property tricks).
 */

import { Op } from 'sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';

import { get_sequelize } from '../db/sequelize.js';
import { AgentCatalog } from '../models/agent_catalog.model.js';
import { SemVer } from './semver.js';

export type Team_agent_ref = {
    scope: string;
    name: string;
    version: string | null;
};

export interface AgentRef {
    readonly name: string;
    readonly version: string | null;
}

export interface MissingAgent {
    readonly name: string;
    readonly required_version: string | null;
    readonly reason: 'not_registered' | 'version_mismatch';
}

export interface OrgAgentUsageRef {
    scope: string;
    name: string;
    version: string;
    realm_ids: string[];
}

export class AgentWorkflow {
    /**
     * Extract all agent names referenced in a workflow JSON string.
     *
     * Iterates `phases` and `support` arrays, skipping entries with
     * `type: "team"`. Returns bare ref strings (e.g. `"my-linter@0.3.0"`)
     * without stripping the version pin.
     *
     * @param workflow_json - Serialised workflow JSON or null/undefined.
     * @returns Deduplicated set of agent ref strings.
     */
    static extract_agents(workflow_json: string | null | undefined): Set<string> {
        const agents = new Set<string>();
        if (!workflow_json) return agents;
        try {
            const parsed = typeof workflow_json === 'string' ? JSON.parse(workflow_json) : workflow_json;
            const buckets = [parsed?.phases, parsed?.support];
            for (const phases of buckets) {
                if (!Array.isArray(phases)) continue;
                for (const phase of phases) {
                    if (phase?.type === 'team') continue;
                    if (typeof phase?.agent === 'string' && phase.agent.trim()) {
                        agents.add(phase.agent.trim());
                    }
                }
            }
        } catch {
            /* skip unparseable */
        }
        return agents;
    }

    /**
     * Find all teams that reference `agent_name` in any published version.
     *
     * Queries `cliq.teams` joined with `cliq.team_versions`. Returns at most
     * one entry per team (scope/name pair). Falls back to an empty array on
     * any DB error so callers can treat "unknown" the same as "none".
     *
     * @param agent_name - Bare agent name, no version pin.
     * @param sequelize - Optional injected Sequelize instance (defaults to `get_sequelize()`).
     */
    static async find_teams(agent_name: string, sequelize?: Sequelize): Promise<Team_agent_ref[]> {
        const sq = sequelize ?? get_sequelize();
        let rows: Array<{
            scope: string;
            name: string;
            version: string | null;
            workflow_json: string;
        }>;
        try {
            rows = await sq.query(
                `SELECT t.scope, t.name, v.version, v.workflow_json
                 FROM cliq.teams t
                 INNER JOIN cliq.team_versions v ON v.team_id = t.id
                 WHERE v.workflow_json IS NOT NULL AND v.workflow_json <> ''`,
                { type: QueryTypes.SELECT },
            ) as typeof rows;
        } catch {
            return [];
        }

        const seen = new Set<string>();
        const hits: Team_agent_ref[] = [];
        for (const row of rows) {
            const agents = AgentWorkflow.extract_agents(row.workflow_json);
            if (!agents.has(agent_name)) continue;
            const key = `${row.scope}/${row.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            hits.push({
                scope: row.scope,
                name: row.name,
                version: row.version,
            });
        }
        return hits;
    }

    /**
     * Parse an agent ref string into name + optional version pin.
     *
     * `"my-linter@0.3.0"` → `{ name: "my-linter", version: "0.3.0" }`.
     * A leading `@` (scoped packages) or a trailing `@` are treated as part of
     * the name and return `version: null`.
     *
     * @param ref - Raw agent ref string from a workflow.
     */
    static parse_ref(ref: string): AgentRef {
        const at_idx = ref.lastIndexOf('@');
        if (at_idx <= 0) return { name: ref, version: null };

        const name = ref.slice(0, at_idx);
        const version = ref.slice(at_idx + 1);
        if (!name || !version) return { name: ref, version: null };

        return { name, version };
    }

    /**
     * Validate that every agent referenced in a manifest is registered for `org_id`.
     *
     * System agents (flagged `is_system`) are always accepted. Custom agents must
     * exist in `cliq.agent_catalog` for the org. A pinned version must match exactly.
     *
     * @param org_id - Organization to check custom-agent registration against.
     * @param manifest_yaml - Raw workflow/manifest JSON string.
     * @returns `{ ok: true }` when all agents are available, or `{ ok: false, missing }`.
     */
    static async validate_for_dispatch(
        org_id: string,
        manifest_yaml: string,
    ): Promise<{ ok: true } | { ok: false; missing: MissingAgent[] }> {
        const raw_agents = AgentWorkflow.extract_agents(manifest_yaml);
        if (raw_agents.size === 0) return { ok: true };

        const refs = [...raw_agents].map(AgentWorkflow.parse_ref);

        const missing: MissingAgent[] = [];

        for (const ref of refs) {
            const system = await AgentCatalog.findOne({
                where: {
                    name: ref.name,
                    is_system: true,
                    deleted: false,
                },
            });
            if (system) continue;

            const custom = await AgentCatalog.findAll({
                where: {
                    name: ref.name,
                    org_id,
                    deleted: false,
                },
            });

            if (custom.length === 0) {
                missing.push({ name: ref.name, required_version: ref.version, reason: 'not_registered' });
                continue;
            }

            if (ref.version) {
                const exact = custom.find((row) => row.version === ref.version);
                if (!exact) {
                    missing.push({ name: ref.name, required_version: ref.version, reason: 'version_mismatch' });
                }
            }
        }

        if (missing.length > 0) return { ok: false, missing };
        return { ok: true };
    }

    /**
     * Build an agent→usage map from pre-fetched teams, versions, and realms data.
     *
     * @param teams - List of teams with `id`, `scope`, and `name`.
     * @param versions - All team version rows with `team_id`, `version`, `workflow_json`.
     * @param realms - Realm rows with `id` and `team_list` (array of `{scope, slug}`).
     * @param latest_version_fn - Function that picks the max semver from a string[].
     * @returns Map from agent name to sorted list of {@link OrgAgentUsageRef}.
     */
    static build_usage(
        teams: Array<{ id: string; scope: string; name: string }>,
        versions: Array<{ team_id: string; version: string; workflow_json: string }>,
        realms: Array<{ id: string; team_list: Array<{ scope: string; slug: string }> }>,
        latest_version_fn: (versions: string[]) => string,
    ): Map<string, OrgAgentUsageRef[]> {
        // Group versions by team_id.
        const by_team = new Map<string, Array<{ version: string; workflow_json: string }>>();
        for (const v of versions) {
            if (!by_team.has(v.team_id)) by_team.set(v.team_id, []);
            by_team.get(v.team_id)!.push({ version: v.version, workflow_json: v.workflow_json });
        }

        // Build realm lookup: "{scope}/{slug}" → realm_ids[].
        const realm_by_team = new Map<string, string[]>();
        for (const realm of realms) {
            for (const entry of realm.team_list ?? []) {
                const key = `${entry.scope}/${entry.slug}`;
                if (!realm_by_team.has(key)) realm_by_team.set(key, []);
                realm_by_team.get(key)!.push(realm.id);
            }
        }

        const result = new Map<string, OrgAgentUsageRef[]>();

        const sorted_teams = [...teams].sort((a, b) =>
            a.scope !== b.scope ? a.scope.localeCompare(b.scope) : a.name.localeCompare(b.name),
        );
        for (const team of sorted_teams) {
            const team_versions = by_team.get(team.id);
            if (!team_versions || team_versions.length === 0) continue;

            const latest = latest_version_fn(team_versions.map((v) => v.version));
            const latest_entry = team_versions.find((v) => v.version === latest);
            if (!latest_entry) continue;

            const agent_refs = AgentWorkflow.extract_agents(latest_entry.workflow_json);
            const realm_ids = realm_by_team.get(`${team.scope}/${team.name}`) ?? [];

            for (const ref_str of agent_refs) {
                const ref = AgentWorkflow.parse_ref(ref_str);
                if (!result.has(ref.name)) result.set(ref.name, []);
                result.get(ref.name)!.push({
                    scope: team.scope,
                    name: team.name,
                    version: latest,
                    realm_ids: [...realm_ids],
                });
            }
        }

        return result;
    }

    /**
     * Query the database and build the agent→usage map for an org.
     *
     * Scans the org's own scopes plus any teams listed in the org's live realm
     * `team_list` entries. Only considers the latest published version per team.
     */
    static async find_org_usage(
        org_id: string,
        sequelize?: Sequelize,
    ): Promise<Map<string, OrgAgentUsageRef[]>> {
        const sq = sequelize ?? get_sequelize();

        const realms = await sq.query<{ id: string; team_list: Array<{ scope: string; slug: string }> }>(
            `SELECT id, team_list FROM cliq.realms WHERE org_id = :org_id AND deleted = false`,
            { type: QueryTypes.SELECT, replacements: { org_id } },
        );

        const scopes = await sq.query<{ slug: string }>(
            `SELECT slug FROM cliq.scopes WHERE org_id = :org_id`,
            { type: QueryTypes.SELECT, replacements: { org_id } },
        );

        const scope_slugs = scopes.map((s) => s.slug);
        const listed_teams = realms.flatMap((r) => r.team_list ?? []);

        if (scope_slugs.length === 0 && listed_teams.length === 0) {
            return new Map();
        }

        // Build WHERE clause: scope IN (...) OR (scope=:ls0 AND name=:ln0) OR ...
        const parts: string[] = [];
        const replacements: Record<string, unknown> = {};
        if (scope_slugs.length > 0) {
            replacements['scopes'] = scope_slugs;
            parts.push(`t.scope IN (:scopes)`);
        }
        listed_teams.forEach(({ scope, slug }, i) => {
            replacements[`ls${i}`] = scope;
            replacements[`ln${i}`] = slug;
            parts.push(`(t.scope = :ls${i} AND t.name = :ln${i})`);
        });

        const teams = await sq.query<{ id: string; scope: string; name: string }>(
            `SELECT t.id, t.scope, t.name FROM cliq.teams t WHERE ${parts.join(' OR ')}`,
            { type: QueryTypes.SELECT, replacements },
        );

        if (teams.length === 0) return new Map();

        const team_ids = teams.map((t) => t.id);
        const versions = await sq.query<{ team_id: string; version: string; workflow_json: string }>(
            `SELECT v.team_id, v.version, v.workflow_json
             FROM cliq.team_versions v
             WHERE v.team_id IN (:team_ids) AND v.workflow_json IS NOT NULL AND v.workflow_json <> ''`,
            { type: QueryTypes.SELECT, replacements: { team_ids } },
        );

        return AgentWorkflow.build_usage(teams, versions, realms, (vs) => SemVer.max(vs) ?? vs[0] ?? '');
    }
}

// ---------------------------------------------------------------------------
// Standalone exports — import-mockable aliases for use in services / tests
// ---------------------------------------------------------------------------

export const extract_agents_from_workflow = (wf: string | null | undefined): Set<string> =>
    AgentWorkflow.extract_agents(wf);

export const parse_agent_ref = (ref: string): AgentRef => AgentWorkflow.parse_ref(ref);

export const validate_agents_for_dispatch = (
    org_id: string,
    manifest_yaml: string,
): Promise<{ ok: true } | { ok: false; missing: MissingAgent[] }> =>
    AgentWorkflow.validate_for_dispatch(org_id, manifest_yaml);

export const find_teams_using_agent = (
    agent_name: string,
    sequelize?: Sequelize,
): Promise<Team_agent_ref[]> => AgentWorkflow.find_teams(agent_name, sequelize);

export const build_agent_usage = (
    teams: Array<{ id: string; scope: string; name: string }>,
    versions: Array<{ team_id: string; version: string; workflow_json: string }>,
    realms: Array<{ id: string; team_list: Array<{ scope: string; slug: string }> }>,
    latest_version_fn: (versions: string[]) => string,
): Map<string, OrgAgentUsageRef[]> =>
    AgentWorkflow.build_usage(teams, versions, realms, latest_version_fn);

export const find_org_agent_usage = (
    org_id: string,
    sequelize?: Sequelize,
): Promise<Map<string, OrgAgentUsageRef[]>> =>
    AgentWorkflow.find_org_usage(org_id, sequelize);
