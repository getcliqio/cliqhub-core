/**
 * Users: directory reads, profile updates and site-admin account management.
 *
 * Routes: /v1/users/get, /v1/users/get_by_id, /v1/users/update, and on the
 * BFF-only plane /internal/users/new, delete, suspend, unsuspend,
 * reset_password (site admin, or public "Forgot password" with `{ email }`),
 * change_password (signed in, or public with `{ reset_token }`), set_role,
 * update_role.
 */
import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { UsersService } from '../services/users_service.js';
import { get_logger } from '../lib/log.js';
import {
    users_get_schema, users_get_by_id_schema, users_new_schema,
    users_update_schema, users_delete_schema, users_suspend_schema,
    users_unsuspend_schema, users_reset_password_schema, users_set_role_schema,
    users_update_role_schema, users_change_password_schema,
    users_forgot_password_schema, users_change_password_with_token_schema,
} from '../schemas/user_types.js';
import { to_user_dto } from '../lib/mappers.js';
import { read_field } from '../auth/route_policy/engine.js';
import type { FieldRef } from '../auth/route_policy/policy.js';

/** Whether the body carries `field`, decided exactly as the route policy's `by_body` rule decides. */
function body_has(req: Request, field: FieldRef): boolean {
    return read_field({ method: req.method, path: req.path, body: req.body }, field) !== undefined;
}

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
            sort_by: body.sort_by,
            sort_dir: body.sort_dir,
            include_deleted: body.include_deleted,
        });
        this.ok(res, result);
    }

    async get_by_id(req: Request, res: Response): Promise<void> {
        log.debug('get_by_id', { user_id: req.auth?.user?.id });
        const body = this.parse_body(users_get_by_id_schema, req);
        const result = await this._users_service.get_by_id(req.auth, body);
        this.ok(res, result);
    }

    /** `POST /internal/users/new` — invited user + "Set your password" email (site admin). */
    async new_user(req: Request, res: Response): Promise<void> {
        log.debug('new_user', { user_id: req.auth?.user?.id });
        const body = this.parse_body(users_new_schema, req);
        const result = await this._users_service.new_user(req.auth, body);
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

    /**
     * `POST /internal/users/reset_password` — `{ user_id }` (site admin) emails
     * a reset link; `{ email }` (public "Forgot password") always answers
     * `{ requested: true }` and is rate-limited per email.
     */
    async reset_password(req: Request, res: Response): Promise<void> {
        log.debug('reset_password', { user_id: req.auth?.user?.id });
        if (body_has(req, 'body.email')) {
            const body = this.parse_body(users_forgot_password_schema, req);
            this.ok(res, await this._users_service.forgot_password(body));
            return;
        }
        const body = this.parse_body(users_reset_password_schema, req);
        const result = await this._users_service.reset_password(req.auth, body);
        log.info('password_reset_sent', { target_user_id: body.user_id, email_sent: result.email_sent });
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

    /**
     * `POST /internal/users/change_password` — `{ current_password, new_password }`
     * signed in, or `{ reset_token, new_password }` from an emailed link (public).
     */
    async change_password(req: Request, res: Response): Promise<void> {
        log.debug('change_password', { user_id: req.auth?.user?.id });
        if (body_has(req, 'body.reset_token')) {
            const body = this.parse_body(users_change_password_with_token_schema, req);
            this.ok(res, await this._users_service.change_password_with_token(body));
            return;
        }
        const body = this.parse_body(users_change_password_schema, req);
        this.ok(res, await this._users_service.change_password(req.auth, body));
    }
}
