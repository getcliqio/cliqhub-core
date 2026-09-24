/**
 * Hub Agents service — CRUD for `cliq.agent_catalog`.
 *
 * Instance methods (no static). Every query is org-scoped: results include
 * the org's custom agents plus all system agents (`is_system = true`).
 *
 * Identity: agents are keyed by `(org_id, name, version)`.
 * System agents have `org_id = NULL`.
 */

import { randomUUID } from 'node:crypto';
import { Op, type WhereOptions } from 'sequelize';

import { AgentCatalog, Realm, RealmAgentSetting } from '../models/index.js';
import { OrgAgentSetting, Team, TeamVersion } from '../db/models/index.js';
import { ApiError } from '../lib/api_error.js';
import { find_teams_using_agent, extract_agents_from_workflow, parse_agent_ref } from '../lib/agent_catalog_usage.js';
import { resolve_agent_settings, type Setting_def } from '../lib/agent_settings_schema.js';
import type { Agent_catalog_entry } from '../schemas/agents_schemas.js';
import type { TeamListEntry } from '../models/realm.model.js';
import { max_semver } from '../lib/semver.js';

export type Agent_list_filters = {
    query?: string;
    names?: string[];
    agent_type?: string;
};

/**
 * Parse a manifest that may be a JSON string or already an object.
 * Throws ApiError on invalid input.
 */
function parse_manifest(raw: string | Record<string, unknown>): Record<string, unknown> {
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        return raw;
    }
    try {
        const parsed: unknown = JSON.parse(String(raw));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('manifest must be a JSON object');
        }
        return parsed as Record<string, unknown>;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw ApiError.bad_request(`invalid agent manifest: ${msg}`);
    }
}

/** Convert a Date/string/number to epoch milliseconds. */
function ts_ms(value: Date | string | number): number {
    if (typeof value === 'number') return value;
    if (value instanceof Date) return value.getTime();
    return new Date(value).getTime();
}

/** Build a WHERE clause for active (non-deleted) rows with optional extras. */
function active_where(extra?: WhereOptions): WhereOptions {
    return { deleted: false, ...(extra ?? {}) };
}

/**
 * Project an AgentCatalog row to the API response shape.
 * Includes `is_system` flag. Optionally includes manifest.
 */
function to_response(
    row: InstanceType<typeof AgentCatalog>,
    include_manifest: boolean,
): Agent_catalog_entry {
    const base: Agent_catalog_entry = {
        id: row.id,
        name: row.name,
        version: row.version ?? null,
        description: row.description ?? null,
        agent_type: row.agent_type,
        is_system: row.is_system,
        created_at: ts_ms(row.created_at),
        updated_at: ts_ms(row.updated_at),
    };
    if (include_manifest) {
        base.manifest = row.manifest;
    }
    return base;
}

/**
 * Org-scoped WHERE: rows belonging to this org OR system agents.
 * Combined with active_where for non-deleted filtering.
 */
function org_or_system_where(org_id: string, extra?: WhereOptions): WhereOptions {
    return active_where({
        [Op.or]: [
            { org_id },
            { is_system: true },
        ],
        ...extra,
    });
}

export class AgentService {

    /**
     * List active agents visible to the given org.
     * Returns org-registered custom agents + all system agents.
     * Supports optional filters: query (substring), names (exact), agent_type.
     */
    list(
        org_id: string,
        filters: Agent_list_filters = {},
        include_manifest = true,
    ): Promise<Agent_catalog_entry[]> {
        const conditions: WhereOptions[] = [
            { [Op.or]: [{ org_id }, { is_system: true }] },
            { deleted: false },
        ];

        if (filters.names?.length) {
            conditions.push({ name: { [Op.in]: filters.names } });
        }
        if (filters.agent_type) {
            conditions.push({ agent_type: filters.agent_type });
        }
        if (filters.query) {
            const q = `%${filters.query}%`;
            conditions.push({
                [Op.or]: [
                    { name: { [Op.iLike]: q } },
                    { description: { [Op.iLike]: q } },
                ],
            });
        }

        return AgentCatalog.findAll({
            where: { [Op.and]: conditions },
            order: [['name', 'ASC']],
        }).then((rows) => rows.map((r) => to_response(r, include_manifest)));
    }

    /**
     * Fetch a single active agent by name (+ optional version).
     * Searches org-registered agents first, then system agents.
     * Throws 404 if not found.
     */
    async get_by_name(
        org_id: string,
        name: string,
        version?: string,
        include_manifest = true,
    ): Promise<Agent_catalog_entry> {
        const version_filter = version ? { version } : {};
        const agent = await AgentCatalog.findOne({
            where: active_where({
                name,
                ...version_filter,
                [Op.or]: [{ org_id }, { is_system: true }],
            }),
            order: [['updated_at', 'DESC']],
        });
        if (!agent) {
            const label = version ? `'${name}' v${version}` : `'${name}'`;
            throw ApiError.not_found(`agent ${label} not found`);
        }
        return to_response(agent, include_manifest);
    }

    /**
     * Register a custom agent in the given org.
     *
     * Creates a new `(org_id, name, version)` row with `is_system = false`.
     * If the same (org_id, name, version) exists and `force` is true, updates it.
     * If `force` is false and it exists, throws 409.
     * System agent names are allowed (different org_id in the unique index).
     */
    async register(
        org_id: string,
        data: {
            name: string;
            version?: string;
            manifest: string | Record<string, unknown>;
            description?: string;
            agent_type?: string;
            force?: boolean;
        },
    ): Promise<{ entry: Agent_catalog_entry; updated: boolean }> {
        const manifest = parse_manifest(data.manifest);
        const version = data.version
            ?? (typeof manifest.version === 'string' ? manifest.version : null);
        const description = data.description
            ?? (typeof manifest.description === 'string' ? manifest.description : null);
        const agent_type = data.agent_type
            ?? (typeof manifest.agent_type === 'string' ? manifest.agent_type : 'exec');

        // Check for existing row with same (org_id, name, version).
        const version_match = version ? { version } : { version: null as string | null };
        const existing = await AgentCatalog.findOne({
            where: { org_id, name: data.name, ...version_match },
        });

        if (existing) {
            if (existing.deleted) {
                throw ApiError.conflict(
                    `agent '${data.name}' was deregistered; contact an admin to restore`,
                );
            }
            if (!data.force) {
                const label = version ? `'${data.name}' v${version}` : `'${data.name}'`;
                throw ApiError.conflict(
                    `agent ${label} already registered in this org (use force to overwrite)`,
                );
            }
            // Force update.
            await existing.update({
                manifest,
                description,
                agent_type,
                updated_at: new Date(),
            });
            return { entry: to_response(existing, true), updated: true };
        }

        const now = new Date();
        const row = await AgentCatalog.create({
            id: randomUUID(),
            name: data.name,
            version,
            description,
            agent_type,
            manifest,
            org_id,
            is_system: false,
            deleted: false,
            deleted_at: null,
            created_at: now,
            updated_at: now,
        });
        return { entry: to_response(row, true), updated: false };
    }

    /**
     * Deregister (soft-delete) custom agent(s) by name.
     *
     * - With `version`: removes only that version.
     * - Without `version`: removes all versions of the agent in the org.
     * - Blocks deregistration of `is_system` rows (403).
     * - Returns 409 when published teams still reference the agent.
     */
    async deregister(
        org_id: string,
        name: string,
        version?: string,
    ): Promise<{ deregistered: boolean; removed_count: number }> {
        const version_filter = version ? { version } : {};
        const rows = await AgentCatalog.findAll({
            where: active_where({ org_id, name, ...version_filter }),
        });

        if (rows.length === 0) {
            return { deregistered: false, removed_count: 0 };
        }

        // Block deregistration of system agents.
        const system_row = rows.find((r) => r.is_system);
        if (system_row) {
            throw ApiError.forbidden(
                `cannot deregister system agent '${name}' — system agents are managed by the platform`,
            );
        }

        // Check if any published teams reference this agent.
        const teams = await find_teams_using_agent(name);
        if (teams.length > 0) {
            const sample = teams.slice(0, 5).map((t) => `@${t.scope}/${t.name}`).join(', ');
            const more = teams.length > 5 ? ` (+${teams.length - 5} more)` : '';
            throw ApiError.conflict(
                `cannot deregister agent '${name}': still referenced by team(s) ${sample}${more}`,
                'agent/in_use',
            );
        }

        const now = new Date();
        const now_ms = Date.now();
        for (const row of rows) {
            await row.update({
                deleted: true,
                deleted_at: now_ms,
                updated_at: now,
            });
        }

        return { deregistered: true, removed_count: rows.length };
    }

    // ── Settings ─────────────────────────────────────────────────────

    /**
     * Get settings schema + current values for an agent.
     *
     * Schema is derived from `agent_catalog.manifest`. Values come from
     * `org_agent_settings` (org-level) and optionally `realm_agent_settings`
     * (realm overrides). Realm values take precedence over org values.
     *
     * Without `realm_id`: returns org-level values only.
     * With `realm_id`: returns effective values (realm override > org fallback).
     */
    async get_settings(
        org_id: string,
        name: string,
        realm_id?: string,
    ): Promise<{
        name: string;
        settings: { required: Setting_def[]; optional: Setting_def[] };
        values: Record<string, string>;
        source: Record<string, 'org' | 'realm' | null>;
        inherited: Record<string, boolean>;
        configured: Record<string, boolean>;
    }> {
        // Look up agent in catalog (org + system).
        const agent = await AgentCatalog.findOne({
            where: active_where({
                name,
                [Op.or]: [{ org_id }, { is_system: true }],
            }),
        });
        if (!agent) throw ApiError.not_found(`agent '${name}' not found`);

        const manifest = agent.manifest ?? {};
        const { required, optional } = resolve_agent_settings(manifest);
        const all_keys = [...required, ...optional].map((s) => s.key);

        // Read org-level settings.
        const org_values: Record<string, string> = {};
        try {
            const org_rows = await OrgAgentSetting.findAll({
                where: { org_id, agent_name: name },
            });
            for (const row of org_rows) {
                const val = String((row as any).value ?? '').trim();
                if (val) org_values[(row as any).setting_key] = val;
            }
        } catch { /* org_agent_settings may not exist yet */ }

        // Read realm-level settings if requested.
        const realm_values: Record<string, string> = {};
        if (realm_id) {
            const realm_rows = await RealmAgentSetting.findAll({
                where: { realm_id, agent_name: name },
            });
            for (const row of realm_rows) {
                const val = String(row.setting_value ?? '').trim();
                if (val) realm_values[row.setting_key] = val;
            }
        }

        // Build effective values, source map, inherited map, configured map.
        const values: Record<string, string> = {};
        const source: Record<string, 'org' | 'realm' | null> = {};
        const inherited: Record<string, boolean> = {};
        const configured: Record<string, boolean> = {};

        for (const key of all_keys) {
            if (realm_id && realm_values[key]) {
                values[key] = realm_values[key];
                source[key] = 'realm';
                inherited[key] = false;
                configured[key] = true;
            } else if (org_values[key]) {
                values[key] = org_values[key];
                source[key] = 'org';
                inherited[key] = !!realm_id; // inherited only relevant in realm context
                configured[key] = true;
            } else {
                values[key] = '';
                source[key] = null;
                inherited[key] = false;
                configured[key] = false;
            }
        }

        return { name, settings: { required, optional }, values, source, inherited, configured };
    }

    /**
     * List agents with a settings summary (name, version, description,
     * is_system flag, required/optional counts, configuration status).
     *
     * Without `realm_id`: returns all agents visible to the org (org-level view).
     * With `realm_id`: returns only agents used by teams in that realm's
     * team_list — resolved on the fly from each team's latest workflow.
     */
    async list_settings_summary(
        org_id: string,
        realm_id?: string,
    ): Promise<Array<{
        name: string;
        version: string | null;
        description: string | null;
        is_system: boolean;
        settings: { required: Setting_def[]; optional: Setting_def[] };
        required_total: number;
        required_configured: number;
        optional_total: number;
        optional_configured: number;
        all_required_configured: boolean;
    }>> {
        /**
         * When scoped to a realm, only return agents referenced by
         * the realm's team_list. Resolved on the fly from each team's
         * latest published workflow.
         */
        const name_filter = realm_id
            ? await this._resolve_realm_agent_names(realm_id)
            : null;

        /** If realm has no teams or no agent refs, return empty. */
        if (name_filter && name_filter.size === 0) return [];

        const where_clause = active_where({
            [Op.or]: [{ org_id }, { is_system: true }],
            ...(name_filter ? { name: { [Op.in]: [...name_filter] } } : {}),
        });

        const agents = await AgentCatalog.findAll({
            where: where_clause,
            order: [['name', 'ASC']],
        });

        const summaries = [];
        for (const agent of agents) {
            const manifest = agent.manifest ?? {};
            const { required, optional } = resolve_agent_settings(manifest);
            const all_keys = [...required, ...optional].map((s) => s.key);

            /** Read org-level settings. */
            const org_values: Record<string, string> = {};
            try {
                const org_rows = await OrgAgentSetting.findAll({
                    where: { org_id, agent_name: agent.name },
                });
                for (const row of org_rows) {
                    const val = String((row as any).value ?? '').trim();
                    if (val) org_values[(row as any).setting_key] = val;
                }
            } catch { /* table may not exist yet */ }

            /** Read realm-level overrides. */
            const realm_values: Record<string, string> = {};
            if (realm_id) {
                try {
                    const realm_rows = await RealmAgentSetting.findAll({
                        where: { realm_id, agent_name: agent.name },
                    });
                    for (const row of realm_rows) {
                        const val = String(row.setting_value ?? '').trim();
                        if (val) realm_values[row.setting_key] = val;
                    }
                } catch { /* table may not exist yet */ }
            }

            let required_configured = 0;
            let optional_configured = 0;
            for (const key of all_keys) {
                const has_value = !!(realm_values[key] || org_values[key]);
                const is_required = required.some((s) => s.key === key);
                if (has_value && is_required) required_configured++;
                if (has_value && !is_required) optional_configured++;
            }

            summaries.push({
                name: agent.name,
                version: agent.version ?? null,
                description: agent.description ?? null,
                is_system: agent.is_system,
                settings: { required, optional },
                required_total: required.length,
                required_configured,
                optional_total: optional.length,
                optional_configured,
                all_required_configured: required.length === 0 || required_configured === required.length,
            });
        }

        return summaries;
    }

    /**
     * Update settings for an agent at org or realm scope.
     *
     * Without `realm_id`: writes to `org_agent_settings`.
     * With `realm_id`: writes to `realm_agent_settings`.
     *
     * Validates that all keys are declared in the agent's manifest schema.
     */
    async update_settings(
        org_id: string,
        name: string,
        settings: { values?: Record<string, string>; clear?: string[] },
        realm_id?: string,
    ): Promise<{ applied: boolean }> {
        // Verify agent exists.
        const agent = await AgentCatalog.findOne({
            where: active_where({
                name,
                [Op.or]: [{ org_id }, { is_system: true }],
            }),
        });
        if (!agent) throw ApiError.not_found(`agent '${name}' not found`);

        // Validate keys against manifest schema.
        const manifest = agent.manifest ?? {};
        const { required, optional } = resolve_agent_settings(manifest);
        const allowed = new Set([...required, ...optional].map((s) => s.key));

        const all_keys = [
            ...Object.keys(settings.values ?? {}),
            ...(settings.clear ?? []),
        ];
        for (const key of all_keys) {
            if (!allowed.has(key)) {
                throw new ApiError(422, `setting key '${key}' is not valid for agent '${name}'`);
            }
        }

        const has_work = (settings.values && Object.keys(settings.values).length > 0)
            || (settings.clear && settings.clear.length > 0);
        if (!has_work) return { applied: false };

        if (realm_id) {
            await this._write_realm_settings(realm_id, name, settings);
        } else {
            await this._write_org_settings(org_id, name, settings);
        }

        return { applied: true };
    }

    /** Write settings to org_agent_settings table. */
    private async _write_org_settings(
        org_id: string,
        agent_name: string,
        settings: { values?: Record<string, string>; clear?: string[] },
    ): Promise<void> {
        if (settings.values) {
            for (const [setting_key, value] of Object.entries(settings.values)) {
                const existing = await OrgAgentSetting.findOne({
                    where: { org_id, agent_name, setting_key },
                });
                if (existing) {
                    await existing.update({ value, updated_at: new Date() });
                } else {
                    await OrgAgentSetting.create({
                        org_id, agent_name, setting_key,
                        value, updated_at: new Date(),
                    });
                }
            }
        }
        if (settings.clear?.length) {
            await OrgAgentSetting.destroy({
                where: { org_id, agent_name, setting_key: settings.clear },
            });
        }
    }

    /** Write settings to realm_agent_settings table. */
    private async _write_realm_settings(
        realm_id: string,
        agent_name: string,
        settings: { values?: Record<string, string>; clear?: string[] },
    ): Promise<void> {
        if (settings.values) {
            for (const [setting_key, setting_value] of Object.entries(settings.values)) {
                const existing = await RealmAgentSetting.findOne({
                    where: { realm_id, agent_name, setting_key },
                });
                if (existing) {
                    await existing.update({ setting_value });
                } else {
                    await RealmAgentSetting.create({
                        realm_id, agent_name, setting_key, setting_value,
                    } as any);
                }
            }
        }
        if (settings.clear?.length) {
            await RealmAgentSetting.destroy({
                where: { realm_id, agent_name, setting_key: settings.clear },
            });
        }
    }

    /**
     * Resolve the set of agent names used by a realm's teams.
     *
     * Reads the realm's `team_list`, resolves each team's latest
     * published workflow, extracts `phases[].agent` references, and
     * returns the deduplicated set of base agent names (version
     * suffixes stripped via `parse_agent_ref`).
     */
    private async _resolve_realm_agent_names(realm_id: string): Promise<Set<string>> {
        const realm = await Realm.findByPk(realm_id, { attributes: ['team_list'] });
        if (!realm) return new Set();

        const team_list: TeamListEntry[] = (realm as any).team_list ?? [];
        if (team_list.length === 0) return new Set();

        const agent_names = new Set<string>();

        for (const entry of team_list) {
            /** Resolve the Hub registry team by scope + slug. */
            const team = await Team.findOne({
                where: { scope: entry.scope, name: entry.slug },
                attributes: ['id'],
                raw: true,
            });
            if (!team) continue;

            /** Find latest version's workflow. */
            const versions = await TeamVersion.findAll({
                where: { team_id: team.id },
                attributes: ['version', 'workflow_json'],
                raw: true,
            });
            if (versions.length === 0) continue;

            const latest_ver = max_semver(versions.map((v) => v.version));
            const target = latest_ver
                ? versions.find((v) => v.version === latest_ver)
                : versions[0];
            if (!target) continue;

            /** Extract agent refs from the workflow. */
            const refs = extract_agents_from_workflow(target.workflow_json);
            for (const ref of refs) {
                agent_names.add(parse_agent_ref(ref).name);
            }
        }

        return agent_names;
    }
}
