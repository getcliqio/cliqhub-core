import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { OrgsService } from '../services/orgs_service.js';
import { OrgRoleService } from '../services/org_role_service.js';
import { ALL_PERMISSIONS, OWNER_ONLY_PERMISSIONS } from '../auth/permissions.js';
import {
    orgs_get_schema, orgs_get_by_id_schema, orgs_new_schema,
    orgs_update_schema, orgs_delete_schema,
    orgs_add_member_schema, orgs_remove_member_schema,
    orgs_list_roles_schema, orgs_get_role_schema, orgs_create_role_schema,
    orgs_update_role_schema, orgs_delete_role_schema,
    orgs_leave_schema, orgs_new_scope_schema, orgs_delete_scope_schema,
    orgs_assign_scope_member_schema, orgs_unassign_scope_member_schema,
    orgs_get_reviewable_targets_schema,
} from '../schemas/orgs_schemas.js';

export class OrgsController extends BaseController {
    constructor(private _orgs_service: OrgsService) {
        super();
    }

    get = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_get_schema, req);
        const result = await this._orgs_service.get(req.auth, {
            search: body.query ?? body.search,
            limit: body.limit,
            offset: body.offset,
            exclude_personal: body.exclude_personal,
            mine: body.mine,
        });
        this.ok(res, result);
    });

    get_by_id = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_get_by_id_schema, req);
        const result = await this._orgs_service.get_by_id(req.auth, body);
        this.ok(res, result);
    });

    /**
     * POST /v1/orgs/get_reviewable_targets — org picker for HUG/dispatch
     * destinations (usernames + notification channels).
     */
    get_reviewable_targets = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_get_reviewable_targets_schema, req);
        const result = await this._orgs_service.get_reviewable_targets(req.auth, body);
        this.ok(res, result);
    });

    new_org = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_new_schema, req);
        const result = await this._orgs_service.new_org(req.auth, body);
        this.ok(res, result);
    });

    update = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_update_schema, req);
        const result = await this._orgs_service.update(req.auth, body);
        this.ok(res, result);
    });

    delete_org = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_delete_schema, req);
        const result = await this._orgs_service.delete_org(req.auth, body);
        this.ok(res, result);
    });

    add_member = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_add_member_schema, req);
        const result = await this._orgs_service.add_member(req.auth, body);
        this.ok(res, result);
    });

    remove_member = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_remove_member_schema, req);
        const result = await this._orgs_service.remove_member(req.auth, body);
        this.ok(res, result);
    });

    list_roles = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_list_roles_schema, req);
        await this._orgs_service.assert_org_member_or_admin(req.auth, body.org_id);
        const roles = await OrgRoleService.list(body.org_id);
        this.ok(res, { roles });
    });

    get_role = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_get_role_schema, req);
        await this._orgs_service.assert_org_member_or_admin(req.auth, body.org_id);
        const role = await OrgRoleService.get(body.org_id, body.role_id);
        this.ok(res, { role });
    });

    create_role = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_create_role_schema, req);
        const { org_id, slug, name, permissions } = body;
        const user = req.auth.user!;
        const role = await OrgRoleService.create(org_id, user.id, { slug, name, permissions }, {
            site_role: user.role,
        });
        this.ok(res, { role });
    });

    update_role = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_update_role_schema, req);
        const { org_id, role_id, name, permissions } = body;
        const user = req.auth.user!;
        const role = await OrgRoleService.update(org_id, user.id, role_id, { name, permissions }, {
            site_role: user.role,
        });
        this.ok(res, { role });
    });

    delete_role = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_delete_role_schema, req);
        const user = req.auth.user!;
        const result = await OrgRoleService.delete(body.org_id, user.id, body.role_id, {
            site_role: user.role,
        });
        this.ok(res, result);
    });

    /** Permission vocabulary for Roles UI. */
    permissions_list = this.wrap(async (_req: Request, res: Response) => {
        this.ok(res, {
            permissions: [...ALL_PERMISSIONS],
            owner_only: [...OWNER_ONLY_PERMISSIONS],
        });
    });

    leave = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_leave_schema, req);
        const result = await this._orgs_service.leave(req.auth, body);
        this.ok(res, result);
    });

    new_scope = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_new_scope_schema, req);
        const result = await this._orgs_service.new_scope(req.auth, body);
        this.ok(res, result);
    });

    delete_scope = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_delete_scope_schema, req);
        const result = await this._orgs_service.delete_scope(req.auth, body);
        this.ok(res, result);
    });

    assign_scope_member = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_assign_scope_member_schema, req);
        const result = await this._orgs_service.assign_scope_member(req.auth, body);
        this.ok(res, result);
    });

    unassign_scope_member = this.wrap(async (req: Request, res: Response) => {
        const body = this.parse_body(orgs_unassign_scope_member_schema, req);
        const result = await this._orgs_service.unassign_scope_member(req.auth, body);
        this.ok(res, result);
    });
}
