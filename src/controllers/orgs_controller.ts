import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import type { OrgsService } from '../services/orgs_service.js';
import type { ScopesService } from '../services/scopes_service.js';
import { OrgRoleService } from '../services/org_role_service.js';
import { ApiError } from '../lib/api_error.js';
import { ALL_PERMISSIONS, OWNER_ONLY_PERMISSIONS } from '../auth/permissions.js';
import type { PagedData, ApiRequest, ApiOkResponse } from '../types/api_response.js';
import {
    OrgsGetInput, OrgIdInput, OrgInput,
    OrgsAddMemberInput, OrgsRemoveMemberInput,
    OrgRoleIdInput, OrgRoleInput,
    OrgScopeInput, OrgScopeMemberInput,
    OrgsGetScopesInput, OrgsGetReviewableTargetsInput,
} from '../schemas/orgs/types.js';
import type { OrgData, OrgMemberData } from '../schemas/orgs/types.js';
import type { RoleData } from '../schemas/roles/types.js';
import type { ScopeData } from '../schemas/scopes/types.js';

export class OrgsController extends BaseController {
    constructor(
        private readonly _orgs_service: OrgsService,
        private readonly _scopes_service: ScopesService,
    ) {
        super();
    }

    /**
     * POST /v1/orgs/get
     * List orgs — caller's orgs (mine:true or no admin) or full catalog (site admin).
     */
    async get(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgsGetInput, req);
        const result = await this._orgs_service.get(req.auth, {
            search: body.query,
            limit: body.limit,
            offset: body.offset,
            exclude_personal: body.exclude_personal,
            mine: body.mine,
        });
        this.ok(res, result);
    }

    /**
     * POST /v1/orgs/get_by_id
     * Fetch a single org with members, roles, and scopes populated.
     */
    async get_by_id(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgIdInput, req);
        const result = await this._orgs_service.get_by_id(req.auth, body);
        this.ok(res, result);
    }

    /**
     * POST /v1/orgs/new — create a new org (site admin only).
     * POST /v1/orgs/update — rename an existing org.
     * Both use OrgInput; controller branches on org_id presence.
     */
    async new_org(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgInput, req);
        if (!body.slug) {
            throw ApiError.unprocessable('slug is required to create an org');
        }
        if (!body.admin_username) {
            throw ApiError.unprocessable('admin_username is required to create an org');
        }
        const result = await this._orgs_service.new_org(req.auth, {
            slug: body.slug,
            display_name: body.display_name,
            admin_username: body.admin_username,
            admin_email: body.admin_email,
            admin_password: body.admin_password,
            admin_display_name: body.admin_display_name,
        });
        this.ok(res, result);
    }

    async update(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgInput, req);
        if (!body.org_id) {
            throw ApiError.unprocessable('org_id is required to update an org');
        }
        if (!body.display_name) {
            throw ApiError.unprocessable('display_name is required');
        }
        const result = await this._orgs_service.update(req.auth, {
            org_id: body.org_id,
            display_name: body.display_name,
        });
        this.ok(res, result);
    }

    /**
     * POST /v1/orgs/delete — permanently delete an org (site admin only).
     */
    async delete_org(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgIdInput, req);
        const result = await this._orgs_service.delete_org(req.auth, body);
        this.ok(res, result);
    }

    /**
     * POST /v1/orgs/leave — caller leaves an org.
     */
    async leave(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgIdInput, req);
        const result = await this._orgs_service.leave(req.auth, body);
        this.ok(res, result);
    }

    /**
     * POST /v1/orgs/add_member — add a user to an org by username, email, or user_id.
     */
    async add_member(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgsAddMemberInput, req);
        const result = await this._orgs_service.add_member(req.auth, body);
        this.ok(res, result);
    }

    /**
     * POST /v1/orgs/remove_member — remove a member from an org.
     */
    async remove_member(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgsRemoveMemberInput, req);
        const result = await this._orgs_service.remove_member(req.auth, body);
        this.ok(res, result);
    }

    /**
     * POST /v1/orgs/list_roles — list all custom roles in an org.
     */
    async list_roles(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgIdInput, req);
        await this._orgs_service.assert_org_member_or_admin(req.auth, body.org_id);
        const roles = await OrgRoleService.list(body.org_id);
        this.ok(res, { roles });
    }

    /**
     * POST /v1/orgs/get_role — fetch a single custom role.
     */
    async get_role(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgRoleIdInput, req);
        await this._orgs_service.assert_org_member_or_admin(req.auth, body.org_id);
        const role = await OrgRoleService.get(body.org_id, body.role_id);
        this.ok(res, { role });
    }

    /**
     * POST /v1/orgs/create_role — create a custom role (org owner or site admin).
     * POST /v1/orgs/update_role — update a custom role.
     * Both use OrgRoleInput; controller branches on role_id presence.
     */
    async create_role(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgRoleInput, req);
        if (!body.slug) {
            throw ApiError.unprocessable('slug is required to create a role');
        }
        if (!body.name) {
            throw ApiError.unprocessable('name is required to create a role');
        }
        const user = req.auth?.user;
        if (!user) throw ApiError.unauthorized('Authentication required');
        const role = await OrgRoleService.create(
            body.org_id,
            user.id,
            { slug: body.slug, name: body.name, permissions: body.permissions ?? [] },
            { site_role: user.role },
        );
        this.ok(res, { role });
    }

    async update_role(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgRoleInput, req);
        if (!body.role_id) {
            throw ApiError.unprocessable('role_id is required to update a role');
        }
        if (body.name === undefined && body.permissions === undefined) {
            throw ApiError.unprocessable('At least one of name or permissions is required');
        }
        const user = req.auth?.user;
        if (!user) throw ApiError.unauthorized('Authentication required');
        const role = await OrgRoleService.update(
            body.org_id,
            user.id,
            body.role_id,
            { name: body.name, permissions: body.permissions },
            { site_role: user.role },
        );
        this.ok(res, { role });
    }

    /**
     * POST /v1/orgs/delete_role — remove a custom role.
     */
    async delete_role(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgRoleIdInput, req);
        const user = req.auth?.user;
        if (!user) throw ApiError.unauthorized('Authentication required');
        const result = await OrgRoleService.delete(
            body.org_id,
            user.id,
            body.role_id,
            { site_role: user.role },
        );
        this.ok(res, result);
    }

    /** POST /permissions/list — permission vocabulary for the Roles UI. */
    async permissions_list(_req: Request, res: Response): Promise<void> {
        this.ok(res, {
            permissions: [...ALL_PERMISSIONS],
            owner_only: [...OWNER_ONLY_PERMISSIONS],
        });
    }

    /**
     * POST /v1/orgs/get_reviewable_targets
     * Returns org members + notification channels the caller can pick as HUG
     * reviewers or dispatch targets.
     */
    async get_reviewable_targets(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgsGetReviewableTargetsInput, req);
        const result = await this._orgs_service.get_reviewable_targets(req.auth, body);
        this.ok(res, result);
    }

    // ── Scope mutations (under /v1/orgs/* — scopes are owned by orgs) ─────────

    /**
     * POST /v1/orgs/new_scope — create a scope under an org.
     */
    async new_scope(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgScopeInput, req);
        if (!body.slug) {
            throw ApiError.unprocessable('slug is required to create a scope');
        }
        const result = await this._orgs_service.new_scope(req.auth, {
            org_id: body.org_id,
            slug: body.slug,
            display_name: body.display_name,
            visibility: body.visibility,
        });
        this.ok(res, result);
    }

    /**
     * POST /v1/orgs/update_scope — rename, change visibility, or transfer ownership of a scope.
     */
    async update_scope(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgScopeInput, req);
        if (!body.scope_id) {
            throw ApiError.unprocessable('scope_id is required to update a scope');
        }
        if (body.display_name === undefined && body.visibility === undefined && body.owner_id === undefined) {
            throw ApiError.unprocessable('At least one of display_name, visibility, or owner_id is required');
        }
        const result = await this._scopes_service.update(req.auth, {
            scope_id: body.scope_id,
            display_name: body.display_name,
            visibility: body.visibility,
            owner_id: body.owner_id,
        });
        this.ok(res, result);
    }

    /**
     * POST /v1/orgs/delete_scope — permanently remove a scope from an org.
     */
    async delete_scope(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgScopeInput, req);
        if (!body.scope_id) {
            throw ApiError.unprocessable('scope_id is required to delete a scope');
        }
        const result = await this._orgs_service.delete_scope(req.auth, {
            org_id: body.org_id,
            scope_id: body.scope_id,
        });
        this.ok(res, result);
    }

    /**
     * POST /v1/orgs/assign_scope_member — grant a user publish access to a scope.
     */
    async assign_scope_member(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgScopeMemberInput, req);
        const result = await this._orgs_service.assign_scope_member(req.auth, body);
        this.ok(res, result);
    }

    /**
     * POST /v1/orgs/unassign_scope_member — revoke a user's publish access to a scope.
     */
    async unassign_scope_member(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgScopeMemberInput, req);
        const result = await this._orgs_service.unassign_scope_member(req.auth, body);
        this.ok(res, result);
    }

    /**
     * POST /v1/orgs/get_scopes
     *
     * Authorization rules:
     * - user_id = caller's own id → always allowed (own scopes)
     * - user_id = another user   → require org admin (if org_id provided) or site admin
     * - user_id absent           → site admin only; returns full scope catalog
     */
    async get_scopes(req: Request, res: Response): Promise<void> {
        const body = this.parse_body(OrgsGetScopesInput, req);
        const user = req.auth?.user;
        if (!user) throw ApiError.unauthorized('Authentication required');

        if (body.user_id) {
            if (body.user_id !== user.id) {
                if (body.org_id) {
                    await this._orgs_service.assert_org_member_or_admin(req.auth!, body.org_id);
                } else if (user.role !== 'admin') {
                    throw ApiError.forbidden('Viewing another user\'s scopes requires org admin or site admin');
                }
            }
            const result = await this._scopes_service.get_for_user(req.auth!, body.user_id, {
                org_id: body.org_id,
                search: body.query,
                limit: body.limit,
                offset: body.offset,
            });
            this.ok(res, result);
        } else {
            if (user.role !== 'admin') {
                throw ApiError.forbidden('Listing all scopes requires an admin token');
            }
            const result = await this._scopes_service.list_catalog(req.auth!, {
                org_id: body.org_id,
                search: body.query,
                limit: body.limit,
                offset: body.offset,
            });
            this.ok(res, result);
        }
    }
}
