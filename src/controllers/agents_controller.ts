/**
 * Hub Agents API controller — `cliq.agent_catalog` CRUD + settings.
 *
 * Routes (1:1 with this controller):
 *   POST /v1/agents/get
 *   POST /v1/agents/get_details
 *   POST /v1/agents/register
 *   POST /v1/agents/deregister
 *   POST /v1/agents/get_settings
 *   POST /v1/agents/update_settings
 *
 * Tenancy (AG-1a): body `org_id`, checked by the route policy — never X-Org-Id / current_org_id.
 *
 * Permission model: site admins and daemon tokens bypass role checks.
 * Regular users need `agents.view` for reads, `agents.manage` for writes,
 * and `agents.manage.realm` for realm-scoped setting overrides.
 *
 * Request/response typing uses `ApiRequest<Body, Data>` / `ApiOkResponse<Data>`.
 * Inbound SoT: PascalCase Zod `Agents*Input` in `schemas/agents/types.ts`.
 */

import type { Request } from 'express';

import { BaseController } from './base_controller.js';
import { AgentService } from '../services/agent.service.js';
import { ApiError } from '../lib/api_error.js';
import { ApiError as LegacyApiError } from '../errors/api_error.js';
import { RealmRepository } from '../repositories/realm_repository.js';
import { require_permission } from '../auth/permissions.js';
import { mask_settings } from '../lib/agent_secrets.js';
import { AgentWorkflow, type OrgAgentUsageRef } from '../lib/agent_workflow.js';

const _realm_repo_agc = new RealmRepository();
import type { ApiOkResponse, ApiRequest, BooleanData } from '../types/api_response.js';
import type { AgentData } from '../schemas/agent_types.js';
import type { SettingsData } from '../schemas/settings_types.js';
import {
    AgentsGetInput,
    AgentsGetDetailsInput,
    AgentsRegisterInput,
    AgentsDeregisterInput,
    AgentsGetSettingsInput,
    AgentsUpdateSettingsInput,
} from '../schemas/agent_types.js';
import type { AuthContext } from '../schemas/auth_types.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('ctrl.agents');

export type PermissionCheckFn = (org_id: string, user_id: string, perm: string) => Promise<boolean>;
export type UsageFn = (org_id: string) => Promise<Map<string, OrgAgentUsageRef[]>>;

/** Writes one audit row. Details carry key names only — never setting values. */
type AuditFn = (actor_id: string, action: string, target_type: string, target_id: string, details: Record<string, unknown>) => Promise<void>;

interface AgentsControllerOpts {
    permission_check?: PermissionCheckFn;
    usage?: UsageFn;
    audit?: AuditFn;
}

/**
 * Default permission check — delegates to `require_permission`.
 * Returns `true` on success, `false` on 403, rethrows anything else.
 */
export async function default_permission_check(
    org_id: string,
    user_id: string,
    perm: string,
): Promise<boolean> {
    try {
        await require_permission(org_id, user_id, perm);
        return true;
    } catch (err) {
        if (err instanceof LegacyApiError && err.status === 403) return false;
        throw err;
    }
}

const MASK_BULLET = '••••';

function _is_masked(value: string): boolean {
    return typeof value === 'string' && value.startsWith(MASK_BULLET);
}

export class AgentsController extends BaseController {
    private readonly _service: AgentService;
    private readonly _permission_check: PermissionCheckFn;
    private readonly _usage: UsageFn;
    private readonly _audit: AuditFn;

    constructor(service?: AgentService, opts?: AgentsControllerOpts) {
        super();
        this._service = service ?? new AgentService();
        this._permission_check = opts?.permission_check ?? default_permission_check;
        // Default: org-scoped usage from team workflows (include_usage on agents/get).
        this._usage = opts?.usage ?? ((org_id) => AgentWorkflow.find_org_usage(org_id));
        // Lazy import keeps the controller free of a model dependency at load time.
        this._audit = opts?.audit ?? (async (actor, action, type, id, details) => {
            const { AuditRepository } = await import('../repositories/audit_repository.js');
            await new AuditRepository().create(actor, action, type, id, details);
        });
    }

    /**
     * Returns true when this caller bypasses role checks (site admin or daemon token).
     */
    private _is_privileged(auth: AuthContext | undefined): boolean {
        // Site admin with a user token only. Daemon tokens used to bypass every
        // check here; they have no business on agent admin routes (S18 family).
        return auth?.user?.role === 'admin' && auth?.auth_via !== 'daemon_token';
    }

    /**
     * When settings carry realm_id, realm must belong to the same org_id.
     */
    private async _assert_realm_in_org(realm_id: string | undefined, org_id: string): Promise<void> {
        if (!realm_id) return;
        const realm = await _realm_repo_agc.find_by_id(realm_id);
        if (!realm || realm.org_id !== org_id) {
            throw ApiError.forbidden('realm does not belong to the requested organization');
        }
    }

    /**
     * List agents visible to the target org (custom + system).
     *
     * @param req - Body: {@link AgentsGetInput}
     * @param res - `{ ok: true, data: AgentData[] }`
     */
    async get(req: ApiRequest<AgentsGetInput, AgentData[]>, res: ApiOkResponse<AgentData[]>): Promise<void> {
        const body = this.parse_body(AgentsGetInput, req);
        log.debug('get', { org_id: body.org_id });
        // Route policy: agents.view in body.org_id.

        const include_manifest = body.include_manifest ?? true;
        const agents: AgentData[] = await this._service.list(
            body.org_id,
            { query: body.query, names: body.names, agent_type: body.agent_type },
            include_manifest,
        );

        if (body.include_usage) {
            const usage_map = await this._usage(body.org_id);
            const enriched = agents.map((a) => ({
                ...a,
                used_by: (usage_map.get(a.name) ?? []).map((ref) => ({
                    scope: ref.scope,
                    name: ref.name,
                    version: ref.version,
                    realm_ids: ref.realm_ids,
                })),
            }));
            this.ok(res, enriched as AgentData[]);
            return;
        }

        this.ok(res, agents);
    }

    /**
     * Fetch one agent by catalog id XOR name (+ optional version).
     *
     * @param req - Body: {@link AgentsGetDetailsInput}
     * @param res - `{ ok: true, data: AgentData }`
     */
    async get_details(req: ApiRequest<AgentsGetDetailsInput, AgentData>, res: ApiOkResponse<AgentData>): Promise<void> {
        const body = this.parse_body(AgentsGetDetailsInput, req);
        log.debug('get_details', { org_id: body.org_id, agent_id: body.id });
        // Route policy: agents.view in body.org_id.

        const include_manifest = body.include_manifest ?? true;

        if (body.id) {
            const agent: AgentData = await this._service.get_by_catalog_id(body.org_id, body.id, include_manifest);
            this.ok(res, agent);
            return;
        }

        const agent: AgentData = await this._service.get_by_name(body.org_id, body.name!, body.version, include_manifest);
        this.ok(res, agent);
    }

    /**
     * Register or overwrite a custom agent in the org catalog.
     *
     * @param req - Body: {@link AgentsRegisterInput}
     * @param res - `{ ok: true, data: AgentData }` — HTTP 201 create / 200 overwrite
     */
    async register(req: ApiRequest<AgentsRegisterInput, AgentData>, res: ApiOkResponse<AgentData>): Promise<void> {
        const body = this.parse_body(AgentsRegisterInput, req);
        log.debug('register', { org_id: body.org_id, name: body.name });
        // Route policy: agents.manage in body.org_id.

        const { org_id: _ignored, ...register_fields } = body;
        const { entry, updated } = await this._service.register(body.org_id, register_fields);
        log.info('agent_registered', { org_id: body.org_id, agent_id: entry.id, updated });

        const status = updated ? 200 : 201;
        this.ok(res, entry, status);
    }

    /**
     * Soft-delete a custom agent (blocked for system agents / in-use teams).
     *
     * @param req - Body: {@link AgentsDeregisterInput}
     * @param res - `{ ok: true, data: BooleanData }` — `true` if a row was removed
     */
    async deregister(req: ApiRequest<AgentsDeregisterInput, BooleanData>, res: ApiOkResponse<BooleanData>): Promise<void> {
        const body = this.parse_body(AgentsDeregisterInput, req);
        log.debug('deregister', { org_id: body.org_id, agent_id: body.id });
        // Route policy: agents.manage in body.org_id.

        const removed: BooleanData = await this._service.deregister(body.org_id, {
            id: body.id,
            name: body.name,
            version: body.version,
        });
        log.info('agent_deregistered', { org_id: body.org_id, agent_id: body.id });

        this.ok(res, removed);
    }

    /**
     * Settings schema + current values.
     * Secret values are masked unless the caller holds `agents.reveal`.
     *
     * @param req - Body: {@link AgentsGetSettingsInput}
     * @param res - `{ ok: true, data: SettingsData | SettingsData[] }`
     */
    async get_settings(req: ApiRequest<AgentsGetSettingsInput, SettingsData | SettingsData[]>, res: ApiOkResponse<SettingsData | SettingsData[]>): Promise<void> {
        const body = this.parse_body(AgentsGetSettingsInput, req);
        log.debug('get_settings', { org_id: body.org_id, agent_id: body.id, realm_id: body.realm_id });
        const auth = this.auth_from(req);
        // Route policy: realm view + agents.view when realm_id is set, else org agents.view.
        await this._assert_realm_in_org(body.realm_id, body.org_id);

        const can_reveal = this._is_privileged(auth) ||
            await this._permission_check(body.org_id, auth?.user?.id ?? '', 'agents.reveal');

        if (!body.id) {
            const agents: SettingsData[] = await this._service.list_settings_summary(body.org_id, body.realm_id);
            const out = can_reveal ? agents : agents.map(mask_settings);
            this.ok(res, out);
            return;
        }

        const detail: SettingsData = await this._service.get_settings(body.org_id, body.id, body.realm_id);
        this.ok(res, can_reveal ? detail : mask_settings(detail));
    }

    /**
     * Upsert and/or clear agent setting values (org or realm scope).
     *
     * @param req - Body: {@link AgentsUpdateSettingsInput}
     * @param res - `{ ok: true, data: BooleanData }` — `true` when applied
     */
    async update_settings(req: ApiRequest<AgentsUpdateSettingsInput, BooleanData>, res: ApiOkResponse<BooleanData>): Promise<void> {
        const body = this.parse_body(AgentsUpdateSettingsInput, req);
        log.debug('update_settings', { org_id: body.org_id, agent_id: body.id, realm_id: body.realm_id });
        const auth = this.auth_from(req);
        // Route policy: operate + agents.manage.realm when realm_id is set, else org agents.manage.

        // Masked values must never be written back (they would overwrite the real secret).
        const incoming_values = body.settings?.values ?? {};
        const masked = Object.entries(incoming_values).find(([, v]) => typeof v === 'string' && _is_masked(v));
        if (masked) {
            throw ApiError.bad_request(
                `Value for '${masked[0]}' appears to be masked — fetch without agents.reveal first`,
            );
        }

        await this._assert_realm_in_org(body.realm_id, body.org_id);

        const applied: BooleanData = await this._service.update_settings(body.org_id, body.id, body.settings, body.realm_id);
        log.info('settings_updated', { org_id: body.org_id, agent_id: body.id });

        // Audit who changed which keys (names only — values, secret or not, are never recorded).
        const actor = auth?.user?.id;
        if (actor) {
            const set_keys = Object.keys(incoming_values).sort();
            const cleared = [...(body.settings?.clear ?? [])].sort();
            try {
                await this._audit(actor, 'agents.update_settings', 'agent', body.id, {
                    org_id: body.org_id,
                    ...(body.realm_id ? { realm_id: body.realm_id } : {}),
                    ...(set_keys.length ? { keys_set: set_keys } : {}),
                    ...(cleared.length ? { keys_cleared: cleared } : {}),
                });
            } catch (err) {
                log.warn('settings_audit_failed', { agent_id: body.id, error: (err as Error).message });
            }
        }

        this.ok(res, applied);
    }
}
