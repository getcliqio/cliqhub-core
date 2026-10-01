import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { UsersService } from '../services/users_service.js';
import { get_logger } from '../lib/log.js';
import {
    users_get_schema, users_get_by_id_schema, users_new_schema,
    users_update_schema, users_delete_schema, users_suspend_schema,
    users_unsuspend_schema, users_reset_password_schema, users_set_role_schema,
    users_update_role_schema, users_change_password_schema,
} from '../schemas/user_types.js';
import { to_user_dto } from '../lib/mappers.js';

const log = get_logger('ctrl.users');

export class UsersController extends BaseController {
    constructor(private _users_service: UsersService) {
        super();
    }

    async get(req: Request, res: Response): Promise<void> {
        log.debug('get', { user_id: req.auth?.user?.id });
        const body = this.parse_body(users_get_schema, req);
        const result = await this._users_service.get(req.auth, {
            org_id: body.org_id,
            realm_id: body.realm_id,
            search: body.query ?? body.search,
            role: body.role,
            suspended: body.suspended,
            limit: body.limit,
            offset: body.offset,
        });
        this.ok(res, result);
    }

    async get_by_id(req: Request, res: Response): Promise<void> {
        log.debug('get_by_id', { user_id: req.auth?.user?.id });
        const body = this.parse_body(users_get_by_id_schema, req);
        const result = await this._users_service.get_by_id(req.auth, body);
        this.ok(res, result);
    }

    async new_user(req: Request, res: Response): Promise<void> {
        log.debug('new_user', { user_id: req.auth?.user?.id });
        const body = this.parse_body(users_new_schema, req);
        const result = await this._users_service.new_user(req.auth, body);
        log.info('user_created', { username: body.username, role: body.role ?? 'user' });
        this.ok(res, result);
    }

    async update(req: Request, res: Response): Promise<void> {
        log.debug('update', { user_id: req.auth?.user?.id });
        const body = this.parse_body(users_update_schema, req);
        const result = await this._users_service.update(req.auth, body);
        log.info('user_updated', { target_user_id: body.user_id ?? req.auth?.user?.id, fields: Object.keys(body).filter((k) => k !== 'user_id') });
        if (result.user) {
            this.ok(res, { updated: true, user: to_user_dto(result.user as any) });
            return;
        }
        this.ok(res, result);
    }

    async delete_user(req: Request, res: Response): Promise<void> {
        log.debug('delete_user', { user_id: req.auth?.user?.id });
        const body = this.parse_body(users_delete_schema, req);
        const result = await this._users_service.delete(req.auth, body);
        log.info('user_deleted', { target_user_id: body.user_id });
        this.ok(res, result);
    }

    async suspend(req: Request, res: Response): Promise<void> {
        log.debug('suspend', { user_id: req.auth?.user?.id });
        const body = this.parse_body(users_suspend_schema, req);
        const result = await this._users_service.suspend(req.auth, body);
        log.info('user_suspended', { target_user_id: body.user_id });
        this.ok(res, result);
    }

    async unsuspend(req: Request, res: Response): Promise<void> {
        log.debug('unsuspend', { user_id: req.auth?.user?.id });
        const body = this.parse_body(users_unsuspend_schema, req);
        const result = await this._users_service.unsuspend(req.auth, body);
        log.info('user_unsuspended', { target_user_id: body.user_id });
        this.ok(res, result);
    }

    async reset_password(req: Request, res: Response): Promise<void> {
        log.debug('reset_password', { user_id: req.auth?.user?.id });
        const body = this.parse_body(users_reset_password_schema, req);
        const result = await this._users_service.reset_password(req.auth, body);
        log.info('password_reset', { target_user_id: body.user_id });
        this.ok(res, result);
    }

    async set_role(req: Request, res: Response): Promise<void> {
        log.debug('set_role', { user_id: req.auth?.user?.id });
        const body = this.parse_body(users_set_role_schema, req);
        const result = await this._users_service.set_role(req.auth, body);
        log.info('site_role_changed', { target_user_id: body.user_id, role: body.role });
        this.ok(res, result);
    }

    async update_role(req: Request, res: Response): Promise<void> {
        log.debug('update_role', { user_id: req.auth?.user?.id });
        const body = this.parse_body(users_update_role_schema, req);
        const result = await this._users_service.update_role(req.auth, body);
        log.info('org_member_role_changed', { org_id: body.org_id, target_user_id: body.user_id, role_id: body.role_id });
        this.ok(res, result);
    }

    async change_password(req: Request, res: Response): Promise<void> {
        log.debug('change_password', { user_id: req.auth?.user?.id });
        const body = this.parse_body(users_change_password_schema, req);
        const result = await this._users_service.change_password(req.auth, body);
        log.info('password_changed', {});
        this.ok(res, result);
    }
}
