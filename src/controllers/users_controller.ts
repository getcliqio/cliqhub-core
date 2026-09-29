import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { UsersService } from '../services/users_service.js';
import {
    users_get_schema, users_get_by_id_schema, users_new_schema,
    users_update_schema, users_delete_schema, users_suspend_schema,
    users_unsuspend_schema, users_reset_password_schema, users_set_role_schema,
    users_update_role_schema, users_change_password_schema,
} from '../schemas/users/types.js';
import { to_user_dto } from '../types/mappers.js';

export class UsersController extends BaseController {
    constructor(private _users_service: UsersService) {
        super();
    }

    async get(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(users_get_schema, req);
        const result = await this._users_service.get(req.auth, {
            org_id: body.org_id,
            realm_id: body.realm_id,
            search: body.query ?? body.search,
            limit: body.limit,
            offset: body.offset,
        });
        this.ok(res, result);
    }

    async get_by_id(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(users_get_by_id_schema, req);
        const result = await this._users_service.get_by_id(req.auth, body);
        this.ok(res, result);
    }

    async new_user(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(users_new_schema, req);
        const result = await this._users_service.new_user(req.auth, body);
        this.ok(res, result);
    }

    async update(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(users_update_schema, req);
        const result = await this._users_service.update(req.auth, body);
        if (result.user) {
            this.ok(res, { updated: true, user: to_user_dto(result.user as any) });
            return;
        }
        this.ok(res, result);
    }

    async delete_user(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(users_delete_schema, req);
        const result = await this._users_service.delete(req.auth, body);
        this.ok(res, result);
    }

    async suspend(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(users_suspend_schema, req);
        const result = await this._users_service.suspend(req.auth, body);
        this.ok(res, result);
    }

    async unsuspend(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(users_unsuspend_schema, req);
        const result = await this._users_service.unsuspend(req.auth, body);
        this.ok(res, result);
    }

    async reset_password(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(users_reset_password_schema, req);
        const result = await this._users_service.reset_password(req.auth, body);
        this.ok(res, result);
    }

    async set_role(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(users_set_role_schema, req);
        const result = await this._users_service.set_role(req.auth, body);
        this.ok(res, result);
    }

    async update_role(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(users_update_role_schema, req);
        const result = await this._users_service.update_role(req.auth, body);
        this.ok(res, result);
    }

    async change_password(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(users_change_password_schema, req);
        const result = await this._users_service.change_password(req.auth, body);
        this.ok(res, result);
    }
}
