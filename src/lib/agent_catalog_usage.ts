/**
 * Helpers for AgentCatalogEntry soft-delete, team usage checks,
 * and dispatch-time agent validation.
 */

import { Op } from 'sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';

import { get_sequelize } from '../db/sequelize.js';
import { AgentCatalog } from '../models/agent_catalog.model.js';

export type Team_agent_ref = {
    scope: string;
    name: string;
    version: string | null;
};

/** Collect agent names referenced by workflow phases (and support). */
export function extract_agents_from_workflow(workflow_json: string | null | undefined): Set<string> {
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
 * Find published Hub registry teams (any version) whose workflow references `agent_name`.
 */
export async function find_teams_using_agent(
    agent_name: string,
    sequelize?: Sequelize,
): Promise<Team_agent_ref[]> {
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
             FROM public.teams t
             INNER JOIN public.team_versions v ON v.team_id = t.id
             WHERE v.workflow_json IS NOT NULL AND v.workflow_json <> ''`,
            { type: QueryTypes.SELECT },
        ) as typeof rows;
    } catch {
        // public.teams may be absent in some test DBs
        return [];
    }

    const seen = new Set<string>();
    const hits: Team_agent_ref[] = [];
    for (const row of rows) {
        const agents = extract_agents_from_workflow(row.workflow_json);
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


// ---------------------------------------------------------------------------
// Agent ref parsing (mirrors daemon manifest.ts parse_agent_ref)
// ---------------------------------------------------------------------------

/** Parsed agent reference — name with optional version pin. */
export interface AgentRef {
    readonly name: string;
    readonly version: string | null;
}

/**
 * Parse an agent reference string into name and optional version.
 *
 * `"my-linter@0.3.0"` → `{ name: "my-linter", version: "0.3.0" }`.
 * `"exec"` → `{ name: "exec", version: null }`.
 */
export function parse_agent_ref(ref: string): AgentRef {
    const at_idx = ref.lastIndexOf('@');
    if (at_idx <= 0) return { name: ref, version: null };

    const name = ref.slice(0, at_idx);
    const version = ref.slice(at_idx + 1);
    if (!name || !version) return { name: ref, version: null };

    return { name, version };
}


// ---------------------------------------------------------------------------
// Dispatch-time agent validation
// ---------------------------------------------------------------------------

/** One missing-agent entry returned by validate_agents_for_dispatch. */
export interface MissingAgent {
    readonly name: string;
    readonly required_version: string | null;
    readonly reason: 'not_registered' | 'version_mismatch';
}

/**
 * Validate that all agents referenced by a manifest are available for
 * Hub dispatch.
 *
 * System agents (is_system=true) always pass. Custom agents must be
 * registered in `cliq.agent_catalog` for the org. When a version pin
 * is present (`agent: "name@version"`), the exact version must exist.
 *
 * Returns `{ ok: true }` when everything checks out, or
 * `{ ok: false, missing }` with details for each failing agent.
 */
export async function validate_agents_for_dispatch(
    org_id: string,
    manifest_yaml: string,
): Promise<{ ok: true } | { ok: false; missing: MissingAgent[] }> {
    const raw_agents = extract_agents_from_workflow(manifest_yaml);
    if (raw_agents.size === 0) return { ok: true };

    /** Parse version pins. */
    const refs = [...raw_agents].map(parse_agent_ref);

    const missing: MissingAgent[] = [];

    for (const ref of refs) {
        /** Check system agents first (org_id IS NULL, is_system = true). */
        const system = await AgentCatalog.findOne({
            where: {
                name: ref.name,
                is_system: true,
                deleted: false,
            },
        });
        if (system) continue;

        /** Check org-scoped custom agents. */
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

        /** Version pin check — exact version must exist. */
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
