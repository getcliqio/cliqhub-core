import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { ScopesService } from '../services/scopes_service.js';
import {
    scopes_get_schema, scopes_new_schema,
    scopes_update_schema, scopes_delete_schema,
    scopes_add_user_schema, scopes_remove_user_schema,
} from '../schemas/scopes_schemas.js';

export class ScopesController extends BaseController {
    constructor(private _scopes_service: ScopesService) {
        super();
    }

    get = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(scopes_get_schema, req);
        const result = await this._scopes_service.get(req.auth, {
            mine: body.mine,
            search: body.query ?? body.search,
            limit: body.limit,
            offset: body.offset,
        });
        this.ok(res, result);
    });

    new_scope = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(scopes_new_schema, req);
        const result = await this._scopes_service.new_scope(req.auth, body);
        this.ok(res, result, 201);
    });

    update = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(scopes_update_schema, req);
        const result = await this._scopes_service.update(req.auth, body);
        this.ok(res, result);
    });

    delete_scope = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(scopes_delete_schema, req);
        const result = await this._scopes_service.delete_scope(req.auth, body);
        this.ok(res, result);
    });

    add_user = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(scopes_add_user_schema, req);
        const result = await this._scopes_service.add_user(req.auth, body);
        this.ok(res, result);
    });

    remove_user = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(scopes_remove_user_schema, req);
        const result = await this._scopes_service.remove_user(req.auth, body);
        this.ok(res, result);
    });
}
