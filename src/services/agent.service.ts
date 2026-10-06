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

import { AgentCatalogRepository } from '../repositories/agent_catalog_repository.js';
import { RealmAgentSettingRepository } from '../repositories/realm_agent_setting_repository.js';
import { OrgAgentSettingRepository } from '../repositories/org_agent_setting_repository.js';

const _agent_catalog_repo_as = new AgentCatalogRepository();
const _ras_repo_as = new RealmAgentSettingRepository();
const _oas_repo = new OrgAgentSettingRepository();
import { ApiError } from '../lib/api_error.js';
import { find_teams_using_agent } from '../lib/agent_workflow.js';
import {
    resolve_agent_settings,
    setting_applies,
    applicable_settings,
    SCALAR_INPUT_TYPES,
    SKIP_PROMOTE_INPUTS,
} from '../lib/agent_settings.js';
import type { BooleanData } from '../types/api_response.js';
import type { AgentData } from '../schemas/agent_types.js';
import type { SettingsData, SettingDef } from '../schemas/settings_types.js';
import type { AgentsRegisterInput } from '../schemas/agent_types.js';
import { to_agent_data } from '../lib/mappers.js';
import { get_logger } from '../lib/log.js';
import { MCP_SERVERS_KEY, is_mcp_key, mcp_block, mcp_setting_defs, parse_mcp_servers } from '../lib/mcp_settings.js';

const log = get_logger('svc.agent');

export type AgentListFilters = {
    query?: string;
    names?: string[];
    agent_type?: string;
};

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
        log.debug('list', { org_id });
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

        const rows = await _agent_catalog_repo_as.find_all_q({
            where: { [Op.and]: conditions },
            order: [['name', 'ASC']],
        });
        // Mapper strips internal columns and optionally omits the heavy manifest.
        return rows.map((r) => to_agent_data(r, include_manifest));
    }

    /**
     * Fetch a single active agent by catalog UUID.
     * Custom rows must belong to org_id; system rows are visible to any authorized org.
     */
    async get_by_catalog_id(org_id: string, id: string, include_manifest = true): Promise<AgentData> {
        log.debug('get_by_catalog_id', { org_id, id });
        const agent = await _agent_catalog_repo_as.find_one_q({
            where: this.active_where({ id }),
        });
        if (!agent) {
            throw ApiError.not_found(`agent id '${id}' not found`);
        }
        // System catalog is shared; custom rows are org-scoped.
        if (!agent.is_system && agent.org_id !== org_id) {
            throw ApiError.not_found(`agent id '${id}' not found`);
        }
        return to_agent_data(agent, include_manifest);
    }

    /**
     * Fetch a single active agent by name (+ optional version).
     * Throws 404 if not found.
     */
    async get_by_name(org_id: string, name: string, version?: string, include_manifest = true): Promise<AgentData> {
        log.debug('get_by_name', { org_id, name, version });
        // Omit version → newest matching active row for this name.
        const version_filter = version ? { version } : {};
        const agent = await _agent_catalog_repo_as.find_one_q({
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
    async register(org_id: string, data: Omit<AgentsRegisterInput, 'org_id'>): Promise<{ entry: AgentData; updated: boolean }> {
        log.debug('register', { org_id, name: data.name });
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
        const existing = await _agent_catalog_repo_as.find_one_q({
            where: { org_id, name: data.name, ...version_match },
        });

        // First registration for this key.
        if (!existing) {
            const now = new Date();
            const row = await _agent_catalog_repo_as.create_one({
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
            log.info('agent_registered', { id: row.id, org_id, name: data.name });
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
     * Soft-delete custom agent(s). `id` XOR `name`(+optional `version`).
     */
    async deregister(org_id: string, selector: { id?: string; name?: string; version?: string }): Promise<BooleanData> {
        log.debug('deregister', { org_id, id: selector.id, name: selector.name });
        // UUID → resolve to name(+exact version) then reuse name path.
        if (selector.id) {
            const row = await _agent_catalog_repo_as.find_one_q({
                where: this.active_where({ id: selector.id }),
            });
            if (!row) return false;
            if (row.is_system) {
                throw ApiError.forbidden(
                    `cannot deregister system agent '${row.name}' — system agents are managed by the platform`,
                );
            }
            if (row.org_id !== org_id) return false;
            return this._deregister_by_name(org_id, row.name, row.version ?? undefined);
        }

        return this._deregister_by_name(org_id, selector.name!, selector.version);
    }

    private async _deregister_by_name(org_id: string, name: string, version?: string): Promise<BooleanData> {
        // No version → soft-delete every org version of this name.
        const version_filter = version ? { version } : {};
        const rows = await _agent_catalog_repo_as.find_all_q({
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
        log.info('agent_deregistered', { org_id, name, count: rows.length });

        return true;
    }

    /**
     * Settings schema + current values for one agent by catalog id → SettingsData.
     */
    async get_settings(org_id: string, id: string, realm_id?: string): Promise<SettingsData> {
        log.debug('get_settings', { org_id, id, realm_id });
        // Resolve via UUID — org/system visibility enforced in get_by_catalog_id.
        const agent = await _agent_catalog_repo_as.find_one_q({
            where: this.active_where({ id }),
        });
        if (!agent) throw ApiError.not_found(`agent id '${id}' not found`);
        if (!agent.is_system && agent.org_id !== org_id) {
            throw ApiError.not_found(`agent id '${id}' not found`);
        }

        const name = agent.name;
        const manifest = agent.manifest ?? {};
        const org_values = await this._read_org_values(org_id, name);
        const realm_values = realm_id ? await this._read_realm_values(realm_id, name) : {};
        const { required, optional } = this._settings_schema(manifest, org_values, realm_values);
        const all_keys = [...required, ...optional].map((s) => s.key);

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
            id: agent.id,
            name,
            version: agent.version ?? null,
            description: agent.description ?? null,
            is_system: agent.is_system,
            settings: { required, optional },
            ...maps,
            ...counts,
            ...(mcp_block(manifest) ? { mcp: mcp_block(manifest) } : {}),
        };
    }

    /**
     * Settings summary rows for org (+ system) agents.
     * When `realm_id` is set, values/source reflect realm overlays — the catalog
     * itself is not filtered to team_list (empty team_list used to blank the SPA).
     * → SettingsData[].
     */
    async list_settings_summary(org_id: string, realm_id?: string): Promise<SettingsData[]> {
        log.debug('list_settings_summary', { org_id, realm_id });
        const where_clause = this.active_where({
            [Op.or]: [{ org_id }, { is_system: true }],
        });

        const agents = await _agent_catalog_repo_as.find_all_q({
            where: where_clause,
            order: [['name', 'ASC']],
        });

        // Build one SettingsData card per agent (same overlay rules as get_settings).
        const summaries: SettingsData[] = [];
        for (const agent of agents) {
            const manifest = agent.manifest ?? {};
            const org_values = await this._read_org_values(org_id, agent.name);
            const realm_values = realm_id ? await this._read_realm_values(realm_id, agent.name) : {};
            const { required, optional } = this._settings_schema(manifest, org_values, realm_values);
            const all_keys = [...required, ...optional].map((s) => s.key);

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
                id: agent.id,
                name: agent.name,
                version: agent.version ?? null,
                description: agent.description ?? null,
                is_system: agent.is_system,
                settings: { required, optional },
                ...maps,
                ...counts,
                ...(mcp_block(manifest) ? { mcp: mcp_block(manifest) } : {}),
            });
        }

        return summaries;
    }

    /**
     * Declared settings plus the agent's MCP keys: `mcp.servers` and one
     * required secret per placeholder in the effective server list (realm
     * value, else org value).
     */
    private _settings_schema(
        manifest: Record<string, unknown>,
        org_values: Record<string, string>,
        realm_values: Record<string, string>,
    ): { required: SettingDef[]; optional: SettingDef[] } {
        const { required, optional } = resolve_agent_settings(manifest);
        const mcp = mcp_setting_defs(manifest, realm_values[MCP_SERVERS_KEY] ?? org_values[MCP_SERVERS_KEY]);
        return { required: [...required, ...mcp.required], optional: [...optional, ...mcp.optional] };
    }

    /**
     * Update settings at org or realm scope by catalog id.
     */
    async update_settings(org_id: string, id: string, settings: { values?: Record<string, string>; clear?: string[] }, realm_id?: string): Promise<BooleanData> {
        log.debug('update_settings', { org_id, id, realm_id });
        const agent = await _agent_catalog_repo_as.find_one_q({
            where: this.active_where({ id }),
        });
        if (!agent) throw ApiError.not_found(`agent id '${id}' not found`);
        if (!agent.is_system && agent.org_id !== org_id) {
            throw ApiError.not_found(`agent id '${id}' not found`);
        }

        const name = agent.name;
        // Reject keys that are not declared on the agent manifest.
        const manifest = agent.manifest ?? {};
        const { required, optional } = resolve_agent_settings(manifest);
        const allowed = new Set([...required, ...optional].map((s) => s.key));

        const all_keys = [...Object.keys(settings.values ?? {}), ...(settings.clear ?? [])];
        for (const key of all_keys) {
            if (!allowed.has(key) && !is_mcp_key(manifest, key)) {
                throw new ApiError(422, `setting key '${key}' is not valid for agent '${name}'`);
            }
        }
        // The MCP server list must parse and fit the manifest (transports, presets, custom servers).
        const servers_value = settings.values?.[MCP_SERVERS_KEY];
        const mcp = mcp_block(manifest);
        if (servers_value !== undefined && mcp) {
            const parsed = parse_mcp_servers(servers_value, mcp);
            if ('errors' in parsed) throw new ApiError(422, `invalid MCP servers for agent '${name}': ${parsed.errors.join('; ')}`);
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
            const org_rows = await _oas_repo.find_all_q({ where: { org_id, agent_name } });
            for (const row of org_rows) {
                const val = String((row as { value?: unknown }).value ?? '').trim();
                if (val) org_values[(row as { setting_key: string }).setting_key] = val;
            }
        } catch (err) {
            log.debug('org_agent_settings_unavailable', { error: err instanceof Error ? err.message : String(err) });
            /* org_agent_settings may not exist yet */
        }
        return org_values;
    }

    private async _read_realm_values(realm_id: string, agent_name: string): Promise<Record<string, string>> {
        const realm_values: Record<string, string> = {};
        try {
            const realm_rows = await _ras_repo_as.find_all_q({ where: { realm_id, agent_name } });
            for (const row of realm_rows) {
                const val = String((row as any).setting_value ?? '').trim();
                if (val) realm_values[(row as any).setting_key] = val;
            }
        } catch (err) {
            log.debug('agent_settings_table_unavailable', { error: err instanceof Error ? err.message : String(err) });
            /* table may not exist yet */
        }
        return realm_values;
    }

    private async _write_org_settings(org_id: string, agent_name: string, settings: { values?: Record<string, string>; clear?: string[] }): Promise<void> {
        // Upsert each key; create when missing so first write does not require a prior row.
        if (settings.values) {
            for (const [setting_key, value] of Object.entries(settings.values)) {
                const existing = await _oas_repo.find_one_q({
                    where: { org_id, agent_name, setting_key },
                });
                if (existing) {
                    await existing.update({ value, updated_at: new Date() });
                    continue;
                }
                await _oas_repo.create_one({
                    org_id, agent_name, setting_key, value, updated_at: new Date(),
                });
            }
        }
        // clear removes keys entirely (falls back to unset / inherited).
        if (settings.clear?.length) {
            await _oas_repo.delete_where_q({
                where: { org_id, agent_name, setting_key: settings.clear },
            });
        }
    }

    private async _write_realm_settings(realm_id: string, agent_name: string, settings: { values?: Record<string, string>; clear?: string[] }): Promise<void> {
        if (settings.values) {
            for (const [setting_key, setting_value] of Object.entries(settings.values)) {
                const existing = await _ras_repo_as.find_one_q({
                    where: { realm_id, agent_name, setting_key },
                });
                if (existing) {
                    await existing.update({ setting_value });
                    continue;
                }
                await _ras_repo_as.create_one({
                    id: randomUUID(),
                    realm_id,
                    agent_name,
                    setting_key,
                    setting_value,
                    created_at: new Date(),
                    updated_at: new Date(),
                } as any);
            }
        }
        if (settings.clear?.length) {
            await _ras_repo_as.delete_where_q({
                where: { realm_id, agent_name, setting_key: settings.clear },
            });
        }
    }

}
