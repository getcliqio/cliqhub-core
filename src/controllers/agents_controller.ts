/**
 * Hub Agents API controller — `cliq.agent_catalog` CRUD + settings.
 *
 * Routes (1:1 with this controller):
 *   POST /v1/agents/get
 *   POST /v1/agents/get_by_id
 *   POST /v1/agents/register
 *   POST /v1/agents/deregister
 *   POST /v1/agents/get_settings
 *   POST /v1/agents/update_settings
 *
 * Request/response typing uses `ApiRequest<Body, Data>` / `ApiOkResponse<Data>`.
 * Inbound SoT: PascalCase Zod `Agents*Input` in `schemas/agents/inputs.ts`.
 */

import type { Request } from 'express';

import { BaseController } from './base_controller.js';
import { AgentService } from '../services/agent.service.js';
import { ApiError } from '../lib/api_error.js';
import type { ApiOkResponse, ApiRequest, BooleanData } from '../types/api_response.js';
import type { AgentData } from '../schemas/agents/data.js';
import type { SettingsData } from '../schemas/settings_schemas.js';
import {
    AgentsGetInput,
    AgentsGetByIdInput,
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

    private require_org_id(req: Request): string {
        // Catalog APIs are org-scoped; missing org means the session never selected one.
        const org_id = req.user?.current_org_id;
        if (!org_id) {
            throw ApiError.bad_request('no active organization context');
        }
        return org_id;
    }

    /**
     * List agents visible to the active org (custom + system).
     *
     * @param req - Body: {@link AgentsGetInput} (optional filters)
     * @param res - `{ ok: true, data: AgentData[] }`
     */
    async get(req: ApiRequest<AgentsGetInput, AgentData[]>, res: ApiOkResponse<AgentData[]>): Promise<void> {
        // Bound every catalog read to the caller's active org.
        const org_id = this.require_org_id(req);
        // Empty body is valid — list everything visible to the org.
        const body = this.parse_body(AgentsGetInput, req) ?? {};
        // Manifests are large; callers can opt out for lighter list payloads.
        const include_manifest = body.include_manifest ?? true;

        const agents: AgentData[] = await this._service.list(org_id, { query: body.query, names: body.names, agent_type: body.agent_type }, include_manifest);

        this.ok(res, agents);
    }

    /**
     * Fetch one agent by name (and optional version).
     *
     * @param req - Body: {@link AgentsGetByIdInput}
     * @param res - `{ ok: true, data: AgentData }`
     */
    async get_by_id(req: ApiRequest<AgentsGetByIdInput, AgentData>, res: ApiOkResponse<AgentData>): Promise<void> {
        const org_id = this.require_org_id(req);
        const body = this.parse_body(AgentsGetByIdInput, req);
        const include_manifest = body.include_manifest ?? true;

        // name (+ optional version) is the natural key; service throws 404 when missing.
        const agent: AgentData = await this._service.get_by_name(org_id, body.name, body.version, include_manifest);

        this.ok(res, agent);
    }

    /**
     * Register or overwrite a custom agent in the org catalog.
     *
     * @param req - Body: {@link AgentsRegisterInput}
     * @param res - `{ ok: true, data: AgentData }` — HTTP 201 create / 200 overwrite
     */
    async register(req: ApiRequest<AgentsRegisterInput, AgentData>, res: ApiOkResponse<AgentData>): Promise<void> {
        const org_id = this.require_org_id(req);
        // Zod SoT — reject unknown / invalid fields before persistence.
        const body = this.parse_body(AgentsRegisterInput, req);

        // Service distinguishes first insert vs force-overwrite.
        const { entry, updated } = await this._service.register(org_id, body);

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
        const org_id = this.require_org_id(req);
        const body = this.parse_body(AgentsDeregisterInput, req);

        // false = nothing matched; true = soft-deleted. Conflicts surface as ApiError.
        const removed: BooleanData = await this._service.deregister(org_id, body.name, body.version);

        this.ok(res, removed);
    }

    /**
     * Settings schema + current values.
     * Omit `name` for a summary list; pass `name` for one agent.
     *
     * @param req - Body: {@link AgentsGetSettingsInput}
     * @param res - `{ ok: true, data: SettingsData | SettingsData[] }`
     */
    async get_settings(req: ApiRequest<AgentsGetSettingsInput, SettingsData | SettingsData[]>, res: ApiOkResponse<SettingsData | SettingsData[]>): Promise<void> {
        const org_id = this.require_org_id(req);
        const body = this.parse_body(AgentsGetSettingsInput, req);

        // No name → org-wide summary cards (one SettingsData per agent).
        if (!body.name) {
            const agents: SettingsData[] = await this._service.list_settings_summary(org_id, body.realm_id);
            this.ok(res, agents);
            return;
        }

        // Name present → single agent detail (schema + resolved values).
        const detail: SettingsData = await this._service.get_settings(org_id, body.name, body.realm_id);
        this.ok(res, detail);
    }

    /**
     * Upsert and/or clear agent setting values (org or realm scope).
     *
     * @param req - Body: {@link AgentsUpdateSettingsInput}
     * @param res - `{ ok: true, data: BooleanData }` — `true` when applied
     */
    async update_settings(req: ApiRequest<AgentsUpdateSettingsInput, BooleanData>, res: ApiOkResponse<BooleanData>): Promise<void> {
        const org_id = this.require_org_id(req);
        const body = this.parse_body(AgentsUpdateSettingsInput, req);

        // realm_id present → realm overrides; otherwise write org defaults.
        const applied: BooleanData = await this._service.update_settings(org_id, body.name, body.settings, body.realm_id);

        this.ok(res, applied);
    }
}

/** @deprecated Use AgentsController. */
export const AgentController = AgentsController;
