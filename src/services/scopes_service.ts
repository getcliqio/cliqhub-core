import { ApiError } from '../errors/api_error.js';
import { get_logger } from '../lib/log.js';
import { RESERVED_SCOPES, SLUG_PATTERN } from '../config/env.js';
import type { ScopeRepository } from '../repositories/scope_repository.js';
import type { ScopeMemberRepository } from '../repositories/scope_member_repository.js';
import type { TeamRepository } from '../repositories/team_repository.js';
import type { AuditRepository } from '../repositories/audit_repository.js';
import type { OrgRepository } from '../repositories/org_repository.js';
import type { OrgMemberRepository } from '../repositories/org_member_repository.js';
import type { AuthContext } from '../schemas/auth_types.js';
import { UserRepository } from '../repositories/user_repository.js';
import { Op } from 'sequelize';
import { assert_admin_access } from '../auth/assert_grant.js';

const log = get_logger('svc.scopes');

const user_repo = new UserRepository();

function escape_like(input: string): string {
    return input.replace(/[%_\\]/g, '\\$&');
}

export class ScopesService {
    constructor(
        private _scope_repo: ScopeRepository,
        private _team_repo: TeamRepository,
        private _audit_repo: AuditRepository,
        private _org_repo: OrgRepository,
        private _org_member_repo: OrgMemberRepository,
        private _scope_member_repo: ScopeMemberRepository,
    ) {}

    private _require_auth(auth: AuthContext) {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
    }

    /** Site-admin grant on scopes entity. */
    private _require_scopes_admin(auth: AuthContext) {
        this._require_auth(auth);
        assert_admin_access(auth, 'scopes');
    }

    private async _require_org_admin(auth: AuthContext, org_id: string): Promise<void> {
        this._require_auth(auth);
        if (auth.user!.role === 'admin') return;
        const { require_permission } = await import('../auth/permissions.js');
        // Same permission as the route policy; checked here because the org comes from the scope row.
        await require_permission(org_id, auth.user!.id, 'org.scopes.manage', {
            site_role: auth.user!.role,
        });
    }

    /**
     * Catalog admin (access.scopes) or org admin for the given org.
     * Used for create/delete/membership on org namespaces.
     */
    private async _require_scope_manager(auth: AuthContext, org_id: string | null): Promise<'site' | 'org'> {
        this._require_auth(auth);
        try {
            assert_admin_access(auth, 'scopes');
            return 'site';
        } catch {
            /* fall through to org admin */
        }
        if (org_id == null) {
            throw new ApiError('forbidden', 'Missing scopes:admin on credential grant', 403);
        }
        await this._require_org_admin(auth, org_id);
        return 'org';
    }

    /**
     * Return scopes accessible to a specific user via DB query (owner or member).
     * Replaces the stale auth.scopes session cache used by the old mine:true path.
     */
    async get_for_user(
        auth: AuthContext,
        user_id: string,
        params: { org_id?: string; search?: string; limit?: number; offset?: number },
    ) {
        log.debug('get_for_user', { user_id, org_id: params.org_id });
        this._require_auth(auth);
        const limit = Math.min(params.limit ?? 50, 100);
        const offset = params.offset ?? 0;

        const where: Record<string, unknown> = {};

        const { ScopeMember } = await import('../models/index.js');
        const member_rows = await ScopeMember.findAll({
            where: { user_id },
            attributes: ['scope_id'],
            raw: true,
        });
        const member_scope_ids = (member_rows as Array<{ scope_id: string }>).map((r) => r.scope_id);

        const ownership_filter: Record<string, unknown> = member_scope_ids.length > 0
            ? { [Op.or]: [{ owner_id: user_id }, { id: { [Op.in]: member_scope_ids } }] }
            : { owner_id: user_id };
        Object.assign(where, ownership_filter);

        if (params.org_id) {
            Object.assign(where, { org_id: params.org_id });
        }
        if (params.search) {
            const like = `%${escape_like(params.search)}%`;
            Object.assign(where, {
                [Op.or]: [
                    { slug: { [Op.iLike]: like } },
                    { display_name: { [Op.iLike]: like } },
                ],
            });
        }

        const total = await this._scope_repo.find_count(where as any);
        const rows = await this._scope_repo.find_all(where as any, {
            attributes: ['id', 'slug', 'display_name', 'owner_id', 'org_id', 'visibility', 'scope_type', 'created_at'],
            order: [['slug', 'ASC']],
            limit,
            offset,
            raw: true,
        });

        const items = rows.map((s: any) => ({
            id: s.id,
            slug: s.slug,
            display_name: s.display_name ?? null,
            visibility: s.visibility,
            scope_type: s.scope_type,
            owner_id: s.owner_id,
            org_id: s.org_id ?? null,
            created_at: s.created_at instanceof Date ? s.created_at.toISOString() : s.created_at,
        }));

        return { items, total, offset, limit };
    }

    /**
     * Full scope catalog for site admins — paginated, with optional org filter.
     * Replaces the get() path that required scopes_admin and lacked org_id filter.
     */
    async list_catalog(
        auth: AuthContext,
        params: { org_id?: string; search?: string; limit?: number; offset?: number },
    ) {
        log.debug('list_catalog', { org_id: params.org_id });
        this._require_auth(auth);
        this._require_scopes_admin(auth);
        const limit = Math.min(params.limit ?? 50, 100);
        const offset = params.offset ?? 0;

        const where: Record<string, unknown> = {};
        if (params.org_id) {
            Object.assign(where, { org_id: params.org_id });
        }
        if (params.search) {
            const like = `%${escape_like(params.search)}%`;
            Object.assign(where, {
                [Op.or]: [
                    { slug: { [Op.iLike]: like } },
                    { display_name: { [Op.iLike]: like } },
                ],
            });
        }

        const total = await this._scope_repo.find_count(where as any);
        const rows = await this._scope_repo.find_catalog_page(where as any, {
            order: [['created_at', 'DESC']],
            limit,
            offset,
        });

        const scopes = rows.map((s: any) => ({
            id: s.id,
            slug: s.slug,
            display_name: s.display_name ?? null,
            visibility: s.visibility,
            scope_type: s.scope_type,
            owner_id: s.owner_id,
            org_id: s.org_id ?? null,
            team_count: Number(s.team_count ?? 0),
            owner_username: s.User?.username ?? null,
            created_at: s.created_at instanceof Date ? (s.created_at as Date).toISOString() : s.created_at,
        }));

        return { scopes, total, offset, limit };
    }

    async new_scope(auth: AuthContext, params: {
        slug: string;
        display_name?: string;
        owner_username?: string;
        visibility?: 'public' | 'private';
        scope_type?: 'user' | 'org';
        org_slug?: string;
        org_id?: string;
    }) {
        log.debug('new_scope', { slug: params.slug, org_id: params.org_id });
        this._require_auth(auth);

        const slug = params.slug.toLowerCase();
        if (!SLUG_PATTERN.test(slug)) {
            throw new ApiError('invalid_params', 'Slug must start with a letter and contain only lowercase letters, numbers, and hyphens', 422);
        }
        if (RESERVED_SCOPES.includes(slug)) {
            throw new ApiError('invalid_params', `Scope '${slug}' is reserved`, 422);
        }

        const existing = await this._scope_repo.find_by_slug(slug);
        if (existing) throw new ApiError('conflict', 'Scope already exists', 409);

        let org: { id: string; slug: string } | null = null;
        if (params.org_id != null) {
            org = await this._org_repo.find_by_id(params.org_id);
            if (!org) throw new ApiError('not_found', 'Org not found', 404);
        } else if (params.org_slug) {
            org = await this._org_repo.find_by_slug(params.org_slug.toLowerCase());
            if (!org) throw new ApiError('not_found', `Org '${params.org_slug}' not found`, 404);
        }

        const scope_type = params.scope_type
            ?? (org ? 'org' : 'user');

        if (scope_type === 'org' && !org) {
            throw new ApiError('invalid_params', 'org_id or org_slug is required for org-type scopes', 422);
        }

        const manager = await this._require_scope_manager(auth, org?.id ?? null);

        if (scope_type === 'org' && org) {
            if (slug !== org.slug && !slug.startsWith(`${org.slug}-`)) {
                throw new ApiError(
                    'invalid_params',
                    `Scope slug must be '${org.slug}' or start with '${org.slug}-'`,
                    422,
                );
            }
        }

        let owner_id = auth.user!.id;
        if (params.owner_username) {
            const owner = await user_repo.find_one({ username: params.owner_username.toLowerCase() } as any);
            if (!owner) throw new ApiError('not_found', `User '${params.owner_username}' not found`, 404);
            owner_id = owner.id;
            if (manager === 'org' && owner_id !== auth.user!.id) {
                // Org admins may only create scopes owned by themselves unless site admin.
                throw new ApiError('forbidden', 'Org admins can only set themselves as scope owner', 403);
            }
        } else if (manager === 'site' && scope_type === 'user') {
            throw new ApiError('invalid_params', 'owner_username is required for user scopes', 422);
        }

        if (scope_type === 'org' && org) {
            const membership = await this._org_member_repo.find_by_org_and_user(org.id, owner_id);
            if (!membership) {
                throw new ApiError('invalid_params', 'Owner must be a member of the org', 422);
            }
        }

        const display_name = params.display_name || slug;
        const visibility = scope_type === 'user' ? 'public' : (params.visibility || 'public');
        const org_id = org?.id;

        const scope_id = await this._scope_repo.create(
            slug, display_name, owner_id, visibility, scope_type, undefined, org_id,
        );

        if (scope_type === 'org' && org) {
            const admins = await this._org_member_repo.list_admins_by_org(org.id);
            for (const a of admins) {
                await this._scope_member_repo.create_on_conflict_ignore(scope_id, a.user_id);
            }
        } else {
            await this._scope_member_repo.create_on_conflict_ignore(scope_id, owner_id);
        }

        await this._audit_repo.create(auth.user!.id, 'scope.create', 'scope', slug, {
            owner_id,
            visibility,
            scope_type,
            org_id,
        });

        log.info('scope_created', { scope_id, slug });
        return { id: scope_id, slug };
    }

    async update(auth: AuthContext, params: {
        scope_id: string;
        visibility?: 'public' | 'private';
        display_name?: string;
        owner_id?: string;
    }) {
        log.debug('update', { scope_id: params.scope_id });
        this._require_scopes_admin(auth);

        const scope = await this._scope_repo.find_by_id(params.scope_id);
        if (!scope) throw new ApiError('not_found', 'Scope not found', 404);

        if (params.owner_id !== undefined) {
            const owner = await user_repo.find_by_id(params.owner_id);
            if (!owner) throw new ApiError('not_found', 'Owner user not found', 404);
        }

        const updates: Record<string, unknown> = {};
        const changes: Record<string, unknown> = {};

        if (params.visibility !== undefined && params.visibility !== scope.visibility) {
            if (scope.scope_type === 'user' && params.visibility === 'private') {
                throw new ApiError('invalid_params', 'User scopes cannot be set to private', 422);
            }
            updates.visibility = params.visibility;
            changes.visibility = { from: scope.visibility, to: params.visibility };
        }

        if (params.display_name !== undefined && params.display_name !== scope.display_name) {
            updates.display_name = params.display_name;
            changes.display_name = { from: scope.display_name, to: params.display_name };
        }

        if (params.owner_id !== undefined && params.owner_id !== scope.owner_id) {
            updates.owner_id = params.owner_id;
            changes.owner_id = { from: scope.owner_id, to: params.owner_id };
        }

        if (Object.keys(updates).length === 0) return { updated: false };

        await this._scope_repo.update_where({ id: scope.id } as any, updates);
        await this._audit_repo.create(auth.user!.id, 'scope.update', 'scope', scope.slug, changes);
        log.info('scope_updated', { scope_id: params.scope_id });
        return { updated: true };
    }

    async delete_scope(auth: AuthContext, params: { scope_id: string }) {
        log.debug('delete_scope', { scope_id: params.scope_id });
        this._require_auth(auth);

        const scope = await this._scope_repo.find_by_id(params.scope_id);
        if (!scope) throw new ApiError('not_found', 'Scope not found', 404);

        await this._require_scope_manager(auth, scope.org_id);

        if (scope.org_id != null) {
            const org = await this._org_repo.find_by_id(scope.org_id);
            if (org && scope.slug === org.slug) {
                throw new ApiError('conflict', 'Cannot delete the default org scope', 409);
            }
        }

        const teams = await this._team_repo.list_by_scope(scope.slug);
        if (teams.length > 0) {
            throw new ApiError(
                'invalid_params',
                `Cannot delete scope with ${teams.length} team(s) — delete or transfer teams first`,
                422,
            );
        }

        await this._scope_member_repo.delete_by_scope_id(scope.id);
        await this._scope_repo.delete_by_id(scope.id);
        await this._audit_repo.create(auth.user!.id, 'scope.delete', 'scope', scope.slug, {});
        log.info('scope_deleted', { scope_id: params.scope_id });
        return { deleted: true };
    }

    async add_user(auth: AuthContext, params: { scope_id: string; user_id: string }) {
        log.debug('add_user', { scope_id: params.scope_id, user_id: params.user_id });
        this._require_auth(auth);

        const scope2 = await this._scope_repo.find_by_id(params.scope_id);
        if (!scope2) throw new ApiError('not_found', 'Scope not found', 404);

        await this._require_scope_manager(auth, scope2.org_id);

        if (scope2.org_id != null) {
            const member = await this._org_member_repo.find_by_org_and_user(scope2.org_id, params.user_id);
            if (!member) throw new ApiError('conflict', 'User is not a member of this org', 409);
        } else {
            const user = await user_repo.find_by_id(params.user_id);
            if (!user) throw new ApiError('not_found', 'User not found', 404);
        }

        const existing = await this._scope_member_repo.find_by_scope_and_user(params.scope_id, params.user_id);
        if (existing) throw new ApiError('conflict', 'User is already assigned to this scope', 409);

        await this._scope_member_repo.create(params.scope_id, params.user_id);
        await this._audit_repo.create(auth.user!.id, 'scope.member.add', 'scope', scope2.slug, {
            user_id: params.user_id,
        });
        return { assigned: true };
    }

    async remove_user(auth: AuthContext, params: { scope_id: string; user_id: string }) {
        log.debug('remove_user', { scope_id: params.scope_id, user_id: params.user_id });
        this._require_auth(auth);

        const scope3 = await this._scope_repo.find_by_id(params.scope_id);
        if (!scope3) throw new ApiError('not_found', 'Scope not found', 404);

        await this._require_scope_manager(auth, scope3.org_id);

        const count = await this._scope_member_repo.delete_by_scope_and_user(params.scope_id, params.user_id);
        if (count > 0) {
            await this._audit_repo.create(auth.user!.id, 'scope.member.remove', 'scope', scope3.slug, {
                user_id: params.user_id,
            });
        }
        return { removed: count > 0 };
    }
}
