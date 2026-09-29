/**
 * Admin-only scope management — global catalog operations not scoped to a single org.
 * User-scoped scope listing → OrgsController.get_scopes.
 * Org-scoped scope mutations (new, update, delete, assign/unassign member) → OrgsController.
 */
import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { ScopesService } from '../services/scopes_service.js';
import {
    scopes_get_schema, scopes_new_schema,
    scopes_update_schema, scopes_delete_schema,
} from '../schemas/scopes_schemas.js';

export class ScopesController extends BaseController {
    constructor(private _scopes_service: ScopesService) {
        super();
    }

    /** Admin-only: list all scopes catalog. */
    async get(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(scopes_get_schema, req);
        const result = await this._scopes_service.list_catalog(req.auth, {
            org_id: body.org_id,
            search: body.query ?? body.search,
            limit: body.limit,
            offset: body.offset,
        });
        this.ok(res, result);
    }

    async new_scope(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(scopes_new_schema, req);
        const result = await this._scopes_service.new_scope(req.auth, body);
        this.ok(res, result, 201);
    }

    async update(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(scopes_update_schema, req);
        const result = await this._scopes_service.update(req.auth, body);
        this.ok(res, result);
    }

    async delete_scope(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(scopes_delete_schema, req);
        const result = await this._scopes_service.delete_scope(req.auth, body);
        this.ok(res, result);
    }
}
