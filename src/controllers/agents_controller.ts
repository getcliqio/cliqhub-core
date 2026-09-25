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
 * Tenancy (AG-1a): body `org_id` + `assert_org_authorized` — never X-Org-Id / current_org_id.
 *
 * Request/response typing uses `ApiRequest<Body, Data>` / `ApiOkResponse<Data>`.
 * Inbound SoT: PascalCase Zod `Agents*Input` in `schemas/agents/inputs.ts`.
 */

import type { Request } from 'express';

import { BaseController } from './base_controller.js';
import { AgentService } from '../services/agent.service.js';
import { ApiError } from '../lib/api_error.js';
import { Realm } from '../models/index.js';
import type { AuthContext } from '../types/vo.js';
import type { ApiOkResponse, ApiRequest, BooleanData } from '../types/api_response.js';
import type { AgentData } from '../schemas/agents/data.js';
import type { SettingsData } from '../schemas/settings_schemas.js';
import {
    AgentsGetInput,
    AgentsGetDetailsInput,
    AgentsRegisterInput,
    AgentsDeregisterInput,
    AgentsGetSettingsInput,
    AgentsUpdateSettingsInput,
} from '../schemas/agents/inputs.js';

export class AgentsController extends BaseController {
    private readonly _service: AgentService;

    constructor(service?: AgentService) {
        super();
        this._service = service ?? new AgentService();
    }

    /**
     * Bearer must be allowed to act on `org_id`.
     * PAT/session: org_id ∈ auth.org_ids. Daemon token: realm.org_id === org_id.
     */
    private async assert_org_authorized(auth: AuthContext | undefined, org_id: string): Promise<void> {
        // No credential context — refuse rather than invent tenancy.
        if (!auth) {
            throw ApiError.unauthorized('authentication required');
        }

        // Daemon tokens are realm-bound; tenancy is the realm's org, not a membership list.
        if (auth.auth_via === 'daemon_token') {
            if (!auth.realm_id) {
                throw ApiError.forbidden('daemon token has no realm binding');
            }
            const realm = await Realm.findByPk(auth.realm_id);
            if (!realm || realm.org_id !== org_id) {
                throw ApiError.forbidden('org_id does not match daemon realm organization');
            }
            return;
        }

        // PAT / session: live membership list from auth middleware.
        if (!auth.org_ids.includes(org_id)) {
            throw ApiError.forbidden('not a member of the requested organization');
        }
    }

    /**
     * When settings carry realm_id, realm must belong to the same org_id.
     */
    private async assert_realm_in_org(realm_id: string | undefined, org_id: string): Promise<void> {
        if (!realm_id) return;
        const realm = await Realm.findByPk(realm_id);
        if (!realm || realm.org_id !== org_id) {
            throw ApiError.forbidden('realm does not belong to the requested organization');
        }
    }

    private auth_from(req: Request): AuthContext | undefined {
        return (req as Request & { auth?: AuthContext }).auth;
    }

    /**
     * List agents visible to the target org (custom + system).
     *
     * @param req - Body: {@link AgentsGetInput}
     * @param res - `{ ok: true, data: AgentData[] }`
     */
    async get(req: ApiRequest<AgentsGetInput, AgentData[]>, res: ApiOkResponse<AgentData[]>): Promise<void> {
        // Zod SoT — org_id required; filters optional.
        const body = this.parse_body(AgentsGetInput, req);
        // Tenancy from body + Bearer membership — never X-Org-Id.
        await this.assert_org_authorized(this.auth_from(req), body.org_id);

        const include_manifest = body.include_manifest ?? true;
        const agents: AgentData[] = await this._service.list(
            body.org_id,
            { query: body.query, names: body.names, agent_type: body.agent_type },
            include_manifest,
        );

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
        await this.assert_org_authorized(this.auth_from(req), body.org_id);

        const include_manifest = body.include_manifest ?? true;

        // UUID path — load row then org/system visibility check inside service.
        if (body.id) {
            const agent: AgentData = await this._service.get_by_catalog_id(body.org_id, body.id, include_manifest);
            this.ok(res, agent);
            return;
        }

        // Name path — natural key (+ optional version).
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
        await this.assert_org_authorized(this.auth_from(req), body.org_id);

        // Service distinguishes first insert vs force-overwrite (org_id already authorized).
        const { org_id: _ignored, ...register_fields } = body;
        const { entry, updated } = await this._service.register(body.org_id, register_fields);

        // 201 only on create; overwrite stays 200 so clients can tell the path apart.
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
        await this.assert_org_authorized(this.auth_from(req), body.org_id);

        // false = nothing matched; true = soft-deleted. Conflicts surface as ApiError.
        const removed: BooleanData = await this._service.deregister(body.org_id, {
            id: body.id,
            name: body.name,
            version: body.version,
        });

        this.ok(res, removed);
    }

    /**
     * Settings schema + current values.
     * Omit `id` for a summary list; pass `id` for one agent.
     *
     * @param req - Body: {@link AgentsGetSettingsInput}
     * @param res - `{ ok: true, data: SettingsData | SettingsData[] }`
     */
    async get_settings(req: ApiRequest<AgentsGetSettingsInput, SettingsData | SettingsData[]>, res: ApiOkResponse<SettingsData | SettingsData[]>): Promise<void> {
        const body = this.parse_body(AgentsGetSettingsInput, req);
        await this.assert_org_authorized(this.auth_from(req), body.org_id);
        await this.assert_realm_in_org(body.realm_id, body.org_id);

        // No id → org-wide summary cards (one SettingsData per agent).
        if (!body.id) {
            const agents: SettingsData[] = await this._service.list_settings_summary(body.org_id, body.realm_id);
            this.ok(res, agents);
            return;
        }

        // Catalog UUID → single agent detail (schema + resolved values).
        const detail: SettingsData = await this._service.get_settings(body.org_id, body.id, body.realm_id);
        this.ok(res, detail);
    }

    /**
     * Upsert and/or clear agent setting values (org or realm scope).
     *
     * @param req - Body: {@link AgentsUpdateSettingsInput}
     * @param res - `{ ok: true, data: BooleanData }` — `true` when applied
     */
    async update_settings(req: ApiRequest<AgentsUpdateSettingsInput, BooleanData>, res: ApiOkResponse<BooleanData>): Promise<void> {
        const body = this.parse_body(AgentsUpdateSettingsInput, req);
        await this.assert_org_authorized(this.auth_from(req), body.org_id);
        await this.assert_realm_in_org(body.realm_id, body.org_id);

        // realm_id present → realm overrides; otherwise write org defaults.
        const applied: BooleanData = await this._service.update_settings(body.org_id, body.id, body.settings, body.realm_id);

        this.ok(res, applied);
    }
}

/** @deprecated Use AgentsController. */
export const AgentController = AgentsController;
