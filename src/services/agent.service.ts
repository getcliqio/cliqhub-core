/**
 * Hub Agents service — CRUD for `cliq.agent_catalog` + settings.
 *
 * Instance methods only. Every query is org-scoped: results include the
 * org's custom agents plus all system agents (`is_system = true`).
 *
 * Returns DTOs from `schemas/agents/` (AgentData, SettingsData, …).
 */

import { randomUUID } from 'node:crypto';
import { Op, type WhereOptions } from 'sequelize';

import { AgentCatalog, Realm, RealmAgentSetting } from '../models/index.js';
import { OrgAgentSetting, Team, TeamVersion } from '../db/models/index.js';
import { ApiError } from '../lib/api_error.js';
import { find_teams_using_agent, extract_agents_from_workflow, parse_agent_ref } from '../lib/agent_catalog_usage.js';
import { resolve_agent_settings } from '../lib/agent_settings_schema.js';
import type { BooleanData } from '../types/api_response.js';
import type { AgentData, SettingsData, SettingDef } from '../schemas/agents_schemas.js';
import type { AgentsRegisterInput } from '../schemas/agents/inputs.js';
import { to_agent_data } from '../types/mappers.js';
import type { TeamListEntry } from '../models/realm.model.js';
import { max_semver } from '../lib/semver.js';

export type AgentListFilters = {
    query?: string;
    names?: string[];
    agent_type?: string;
};

/** @deprecated Use AgentListFilters. */
export type Agent_list_filters = AgentListFilters;

type SettingsCounts = Pick<
    SettingsData,
    'required_total' | 'required_configured' | 'optional_total' | 'optional_configured' | 'all_required_configured'
>;

export class AgentService {

    private parse_manifest(raw: string | Record<string, unknown>): Record<string, unknown> {
        // Already an object (common when callers pass JSON bodies through).
        if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
            return raw;
        }
        // String path — must decode to a plain object, never an array/primitive.
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

    private active_where(extra?: WhereOptions): WhereOptions {
        // Soft-deleted rows stay in the table; never surface them on reads.
        return { deleted: false, ...(extra ?? {}) };
    }

    private empty_settings_maps(keys: string[]): Pick<SettingsData, 'values' | 'source' | 'inherited' | 'configured'> {
        // Pre-seed every schema key so the wire shape is stable even when unset.
        const values: Record<string, string> = {};
        const source: Record<string, 'org' | 'realm' | null> = {};
        const inherited: Record<string, boolean> = {};
        const configured: Record<string, boolean> = {};
        for (const key of keys) {
            values[key] = '';
            source[key] = null;
            inherited[key] = false;
            configured[key] = false;
        }
        return { values, source, inherited, configured };
    }

    private count_configured(required: SettingDef[], optional: SettingDef[], configured: Record<string, boolean>): SettingsCounts {
        // UI badges depend on these tallies (required vs optional completeness).
        let required_configured = 0;
        let optional_configured = 0;
        for (const s of required) {
            if (configured[s.key]) required_configured += 1;
        }
        for (const s of optional) {
            if (configured[s.key]) optional_configured += 1;
        }
        return {
            required_total: required.length,
            required_configured,
            optional_total: optional.length,
            optional_configured,
            all_required_configured: required.length === 0 || required_configured === required.length,
        };
    }


    /**
     * List active agents visible to the given org.
     * Returns org-registered custom agents + all system agents.
     */
    async list(org_id: string, filters: AgentListFilters = {}, include_manifest = true): Promise<AgentData[]> {
        // Always include system agents plus this org's custom rows.
        const conditions: WhereOptions[] = [
            { [Op.or]: [{ org_id }, { is_system: true }] },
            { deleted: false },
        ];

        // Optional filters are AND'd onto the base visibility clause.
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

        const rows = await AgentCatalog.findAll({
            where: { [Op.and]: conditions },
            order: [['name', 'ASC']],
        });
        // Mapper strips internal columns and optionally omits the heavy manifest.
        return rows.map((r) => to_agent_data(r, include_manifest));
    }

    /**
     * Fetch a single active agent by name (+ optional version).
     * Throws 404 if not found.
     */
    async get_by_name(org_id: string, name: string, version?: string, include_manifest = true): Promise<AgentData> {
        // Omit version → newest matching active row for this name.
        const version_filter = version ? { version } : {};
        const agent = await AgentCatalog.findOne({
            where: this.active_where({
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
        return to_agent_data(agent, include_manifest);
    }

    /**
     * Register a custom agent in the given org.
     * Creates `(org_id, name, version)` or force-updates when `force` is true.
     */
    async register(org_id: string, data: AgentsRegisterInput): Promise<{ entry: AgentData; updated: boolean }> {
        // Body fields win; otherwise fall back to values declared in the manifest.
        const manifest = this.parse_manifest(data.manifest);
        const version = data.version
            ?? (typeof manifest.version === 'string' ? manifest.version : null);
        const description = data.description
            ?? (typeof manifest.description === 'string' ? manifest.description : null);
        const agent_type = data.agent_type
            ?? (typeof manifest.agent_type === 'string' ? manifest.agent_type : 'exec');

        // Natural key is (org, name, version) including null version.
        const version_match = version ? { version } : { version: null as string | null };
        const existing = await AgentCatalog.findOne({
            where: { org_id, name: data.name, ...version_match },
        });

        // First registration for this key.
        if (!existing) {
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
            return { entry: to_agent_data(row, true), updated: false };
        }

        // Soft-deleted rows are not auto-restored — operator must intervene.
        if (existing.deleted) {
            throw ApiError.conflict(
                `agent '${data.name}' was deregistered; contact an admin to restore`,
            );
        }
        // Without force, colliding actives are a hard conflict.
        if (!data.force) {
            const label = version ? `'${data.name}' v${version}` : `'${data.name}'`;
            throw ApiError.conflict(
                `agent ${label} already registered in this org (use force to overwrite)`,
            );
        }

        // force=true → overwrite manifest in place (updated: true → HTTP 200).
        await existing.update({
            manifest,
            description,
            agent_type,
            updated_at: new Date(),
        });
        return { entry: to_agent_data(existing, true), updated: true };
    }

    /**
     * Soft-delete custom agent(s) by name.
     * With `version`: that version only. Without: all org versions.
     */
    async deregister(org_id: string, name: string, version?: string): Promise<BooleanData> {
        // No version → soft-delete every org version of this name.
        const version_filter = version ? { version } : {};
        const rows = await AgentCatalog.findAll({
            where: this.active_where({ org_id, name, ...version_filter }),
        });

        if (rows.length === 0) {
            return false;
        }

        // Platform system agents are immutable via this API.
        const system_row = rows.find((r) => r.is_system);
        if (system_row) {
            throw ApiError.forbidden(
                `cannot deregister system agent '${name}' — system agents are managed by the platform`,
            );
        }

        // Block delete while any team workflow still references the agent.
        const teams = await find_teams_using_agent(name);
        if (teams.length > 0) {
            const sample = teams.slice(0, 5).map((t) => `@${t.scope}/${t.name}`).join(', ');
            const more = teams.length > 5 ? ` (+${teams.length - 5} more)` : '';
            throw ApiError.conflict(
                `cannot deregister agent '${name}': still referenced by team(s) ${sample}${more}`,
                'agent/in_use',
            );
        }

        // Soft-delete keeps history; register(force) will not revive without admin restore.
        const now = new Date();
        const now_ms = Date.now();
        for (const row of rows) {
            await row.update({ deleted: true, deleted_at: now_ms, updated_at: now });
        }

        return true;
    }

    /**
     * Settings schema + current values for one agent → SettingsData.
     */
    async get_settings(org_id: string, name: string, realm_id?: string): Promise<SettingsData> {
        // Resolve the agent row first — settings are meaningless without a catalog entry.
        const agent = await AgentCatalog.findOne({
            where: this.active_where({
                name,
                [Op.or]: [{ org_id }, { is_system: true }],
            }),
        });
        if (!agent) throw ApiError.not_found(`agent '${name}' not found`);

        // Schema comes from the manifest; values come from org/realm tables overlay.
        const manifest = agent.manifest ?? {};
        const { required, optional } = resolve_agent_settings(manifest);
        const all_keys = [...required, ...optional].map((s) => s.key);

        const org_values = await this._read_org_values(org_id, name);
        const realm_values = realm_id ? await this._read_realm_values(realm_id, name) : {};

        // Realm wins over org when both are set; org under a realm context counts as inherited.
        const maps = this.empty_settings_maps(all_keys);
        for (const key of all_keys) {
            if (realm_id && realm_values[key]) {
                maps.values[key] = realm_values[key];
                maps.source[key] = 'realm';
                maps.inherited[key] = false;
                maps.configured[key] = true;
                continue;
            }
            if (org_values[key]) {
                maps.values[key] = org_values[key];
                maps.source[key] = 'org';
                maps.inherited[key] = !!realm_id;
                maps.configured[key] = true;
            }
        }

        const counts = this.count_configured(required, optional, maps.configured);
        return {
            name,
            version: agent.version ?? null,
            description: agent.description ?? null,
            is_system: agent.is_system,
            settings: { required, optional },
            ...maps,
            ...counts,
        };
    }

    /**
     * Settings summary rows for agents visible to the org (or realm team_list).
     * → SettingsData[].
     */
    async list_settings_summary(org_id: string, realm_id?: string): Promise<SettingsData[]> {
        // Realm context → only agents referenced by that realm's team_list.
        const name_filter = realm_id ? await this._resolve_realm_agent_names(realm_id) : null;

        if (name_filter && name_filter.size === 0) return [];

        const where_clause = this.active_where({
            [Op.or]: [{ org_id }, { is_system: true }],
            ...(name_filter ? { name: { [Op.in]: [...name_filter] } } : {}),
        });

        const agents = await AgentCatalog.findAll({
            where: where_clause,
            order: [['name', 'ASC']],
        });

        // Build one SettingsData card per agent (same overlay rules as get_settings).
        const summaries: SettingsData[] = [];
        for (const agent of agents) {
            const manifest = agent.manifest ?? {};
            const { required, optional } = resolve_agent_settings(manifest);
            const all_keys = [...required, ...optional].map((s) => s.key);

            const org_values = await this._read_org_values(org_id, agent.name);
            const realm_values = realm_id ? await this._read_realm_values(realm_id, agent.name) : {};

            const maps = this.empty_settings_maps(all_keys);
            for (const key of all_keys) {
                if (realm_values[key] || org_values[key]) {
                    maps.values[key] = realm_values[key] ?? org_values[key] ?? '';
                    maps.source[key] = realm_values[key] ? 'realm' : 'org';
                    maps.inherited[key] = !!(realm_id && !realm_values[key] && org_values[key]);
                    maps.configured[key] = true;
                }
            }

            const counts = this.count_configured(required, optional, maps.configured);
            summaries.push({
                name: agent.name,
                version: agent.version ?? null,
                description: agent.description ?? null,
                is_system: agent.is_system,
                settings: { required, optional },
                ...maps,
                ...counts,
            });
        }

        return summaries;
    }

    /**
     * Update settings at org or realm scope.
     */
    async update_settings(org_id: string, name: string, settings: { values?: Record<string, string>; clear?: string[] }, realm_id?: string): Promise<BooleanData> {
        const agent = await AgentCatalog.findOne({
            where: this.active_where({
                name,
                [Op.or]: [{ org_id }, { is_system: true }],
            }),
        });
        if (!agent) throw ApiError.not_found(`agent '${name}' not found`);

        // Reject keys that are not declared on the agent manifest.
        const manifest = agent.manifest ?? {};
        const { required, optional } = resolve_agent_settings(manifest);
        const allowed = new Set([...required, ...optional].map((s) => s.key));

        const all_keys = [...Object.keys(settings.values ?? {}), ...(settings.clear ?? [])];
        for (const key of all_keys) {
            if (!allowed.has(key)) {
                throw new ApiError(422, `setting key '${key}' is not valid for agent '${name}'`);
            }
        }

        // Empty mutation is a no-op (BooleanData false).
        const has_work = (settings.values && Object.keys(settings.values).length > 0)
            || (settings.clear && settings.clear.length > 0);
        if (!has_work) return false;

        // realm_id present → write realm overrides; otherwise org defaults.
        if (realm_id) {
            await this._write_realm_settings(realm_id, name, settings);
            return true;
        }

        await this._write_org_settings(org_id, name, settings);
        return true;
    }

    private async _read_org_values(org_id: string, agent_name: string): Promise<Record<string, string>> {
        const org_values: Record<string, string> = {};
        try {
            // Table may be missing on older deploys — treat as empty map.
            const org_rows = await OrgAgentSetting.findAll({ where: { org_id, agent_name } });
            for (const row of org_rows) {
                const val = String((row as { value?: unknown }).value ?? '').trim();
                if (val) org_values[(row as { setting_key: string }).setting_key] = val;
            }
        } catch {
            /* org_agent_settings may not exist yet */
        }
        return org_values;
    }

    private async _read_realm_values(realm_id: string, agent_name: string): Promise<Record<string, string>> {
        const realm_values: Record<string, string> = {};
        try {
            const realm_rows = await RealmAgentSetting.findAll({ where: { realm_id, agent_name } });
            for (const row of realm_rows) {
                const val = String(row.setting_value ?? '').trim();
                if (val) realm_values[row.setting_key] = val;
            }
        } catch {
            /* table may not exist yet */
        }
        return realm_values;
    }

    private async _write_org_settings(org_id: string, agent_name: string, settings: { values?: Record<string, string>; clear?: string[] }): Promise<void> {
        // Upsert each key; create when missing so first write does not require a prior row.
        if (settings.values) {
            for (const [setting_key, value] of Object.entries(settings.values)) {
                const existing = await OrgAgentSetting.findOne({
                    where: { org_id, agent_name, setting_key },
                });
                if (existing) {
                    await existing.update({ value, updated_at: new Date() });
                    continue;
                }
                await OrgAgentSetting.create({
                    org_id, agent_name, setting_key, value, updated_at: new Date(),
                });
            }
        }
        // clear removes keys entirely (falls back to unset / inherited).
        if (settings.clear?.length) {
            await OrgAgentSetting.destroy({
                where: { org_id, agent_name, setting_key: settings.clear },
            });
        }
    }

    private async _write_realm_settings(realm_id: string, agent_name: string, settings: { values?: Record<string, string>; clear?: string[] }): Promise<void> {
        if (settings.values) {
            for (const [setting_key, setting_value] of Object.entries(settings.values)) {
                const existing = await RealmAgentSetting.findOne({
                    where: { realm_id, agent_name, setting_key },
                });
                if (existing) {
                    await existing.update({ setting_value });
                    continue;
                }
                await RealmAgentSetting.create({
                    id: randomUUID(),
                    realm_id,
                    agent_name,
                    setting_key,
                    setting_value,
                    created_at: new Date(),
                    updated_at: new Date(),
                });
            }
        }
        if (settings.clear?.length) {
            await RealmAgentSetting.destroy({
                where: { realm_id, agent_name, setting_key: settings.clear },
            });
        }
    }

    /**
     * Resolve agent names used by a realm's team_list (latest workflows).
     */
    private async _resolve_realm_agent_names(realm_id: string): Promise<Set<string>> {
        // team_list is the realm's installed teams; empty → no agent filter.
        const realm = await Realm.findByPk(realm_id, { attributes: ['team_list'] });
        if (!realm) return new Set();

        const team_list: TeamListEntry[] = (realm as { team_list?: TeamListEntry[] }).team_list ?? [];
        if (team_list.length === 0) return new Set();

        const agent_names = new Set<string>();

        for (const entry of team_list) {
            const team = await Team.findOne({
                where: { scope: entry.scope, name: entry.slug },
                attributes: ['id'],
                raw: true,
            });
            if (!team) continue;

            // Prefer the highest semver workflow; older versions can lag on agent refs.
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

            const refs = extract_agents_from_workflow(target.workflow_json);
            for (const ref of refs) {
                agent_names.add(parse_agent_ref(ref).name);
            }
        }

        return agent_names;
    }
}
