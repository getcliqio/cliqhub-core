/**
 * Hub Agents API controller — `cliq.agent_catalog` CRUD.
 *
 * Four catalog endpoints (all POST, JSON body):
 *   /v1/agents/get         — list agents visible to caller's org
 *   /v1/agents/get_by_id   — single agent by name (+ optional version)
 *   /v1/agents/register    — register a custom agent in the org
 *   /v1/agents/deregister  — soft-delete custom agent(s)
 *
 * Instance methods only — no static methods. Org derived from auth context.
 * Zod validation on every input. JSDoc on every method.
 */

import { Request, Response, NextFunction } from 'express';

import { AgentService } from '../services/agent.service.js';
import { ApiError } from '../lib/api_error.js';
import {
    agents_get_input,
    agents_get_by_id_input,
    agents_register_input,
    agents_deregister_input,
    agents_get_settings_input,
    agents_update_settings_input,
} from '../schemas/agents_schemas.js';

/** Extract the caller's org_id from auth context. Throws if missing. */
function require_org_id(req: Request): string {
    const org_id = req.user?.current_org_id;
    if (!org_id) {
        throw ApiError.bad_request('no active organization context');
    }
    return org_id;
}

export class AgentController {
    private _service: AgentService;

    constructor(service?: AgentService) {
        this._service = service ?? new AgentService();
    }

    /**
     * List agents visible to the caller's org.
     * Returns system agents + org-registered custom agents.
     * Supports optional filters: query, names[], agent_type, include_manifest.
     */
    async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const org_id = require_org_id(req);
            const body = agents_get_input.parse(req.body) ?? {};
            const include_manifest = body.include_manifest ?? true;

            const agents = await this._service.list(
                org_id,
                {
                    query: body.query,
                    names: body.names,
                    agent_type: body.agent_type,
                },
                include_manifest,
            );

            res.json({ ok: true, agents });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Fetch a single agent by name (+ optional version).
     * Searches the caller's org agents and system agents.
     */
    async get_by_id(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const org_id = require_org_id(req);
            const body = agents_get_by_id_input.parse(req.body);
            const include_manifest = body.include_manifest ?? true;

            const agent = await this._service.get_by_name(
                org_id,
                body.name,
                body.version,
                include_manifest,
            );

            res.json({ ok: true, agent });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Register a custom agent in the caller's org.
     * Creates a new (org_id, name, version) row. Use `force: true` to overwrite.
     */
    async register(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const org_id = require_org_id(req);
            const body = agents_register_input.parse(req.body);

            const { entry, updated } = await this._service.register(org_id, {
                name: body.name,
                version: body.version,
                manifest: body.manifest,
                description: body.description,
                agent_type: body.agent_type,
                force: body.force,
            });

            const status = updated ? 200 : 201;
            res.status(status).json({ ok: true, agent: entry, updated });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Deregister (soft-delete) custom agent(s) from the caller's org.
     * With `version`: removes only that version. Without: removes all versions.
     * System agents are protected (403).
     */
    async deregister(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const org_id = require_org_id(req);
            const body = agents_deregister_input.parse(req.body);

            const { deregistered, removed_count } = await this._service.deregister(
                org_id,
                body.name,
                body.version,
            );

            res.json({ ok: true, deregistered, removed_count });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Get settings schema + current values.
     *
     * With `name`: returns full detail for one agent (settings schema, values, source map).
     * Without `name`: returns a summary list of all agents with settings counts.
     */
    async get_settings(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const org_id = require_org_id(req);
            const body = agents_get_settings_input.parse(req.body);

            if (body.name) {
                const data = await this._service.get_settings(org_id, body.name, body.realm_id);
                res.json({ ok: true, data });
                return;
            }

            /** List mode — return summary for all agents. */
            const agents = await this._service.list_settings_summary(org_id, body.realm_id);
            res.json({ ok: true, agents });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Update settings for an agent at org or realm scope.
     * Without `realm_id`: writes org-level. With `realm_id`: writes realm-level.
     */
    async update_settings(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const org_id = require_org_id(req);
            const body = agents_update_settings_input.parse(req.body);

            const { applied } = await this._service.update_settings(
                org_id,
                body.name,
                body.settings,
                body.realm_id,
            );

            res.json({ ok: true, applied });
        } catch (err) {
            next(err);
        }
    }
}
