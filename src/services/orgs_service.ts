import { ApiError } from '../errors/api_error.js';
import { RESERVED_SCOPES, SLUG_PATTERN, EMAIL_PATTERN, MIN_PASSWORD_LENGTH } from '../config/env.js';
import type { OrgRepository } from '../repositories/org_repository.js';
import type { OrgMemberRepository } from '../repositories/org_member_repository.js';
import type { ScopeRepository } from '../repositories/scope_repository.js';
import type { ScopeMemberRepository } from '../repositories/scope_member_repository.js';
import type { UserRepository } from '../repositories/user_repository.js';
import type { TeamRepository } from '../repositories/team_repository.js';
import type { AuditRepository } from '../repositories/audit_repository.js';
import type { AuthContext } from '../types/vo.js';
import { Op, literal } from 'sequelize';
import { User, Scope, Org, OrgMember, OrgRole, ScopeMember, Team } from '../db/models/index.js';
import { hash_password } from '../auth/password.js';
import { ensure_per_user_channel } from '../services/per_user_channel.service.js';
import { seed_default_roles_for_org } from '../db/migrate_org_roles.js';
import { assert_admin_access } from '../auth/assert_grant.js';
import { RealmService } from '../services/realm.service.js';
import { OrgRealmSyncService } from './org_realm_sync_service.js';

function escape_like(input: string): string {
    return input.replace(/[%_\\]/g, '\\$&');
}

export class OrgsService {
    constructor(
        private _org_repo: OrgRepository,
        private _org_member_repo: OrgMemberRepository,
        private _scope_repo: ScopeRepository,
        private _scope_member_repo: ScopeMemberRepository,
        private _user_repo: UserRepository,
        private _team_repo: TeamRepository,
        private _audit_repo?: AuditRepository,
    ) {}

    private _require_auth(auth: AuthContext) {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
    }

    private _require_admin(auth: AuthContext) {
        this._require_auth(auth);
        assert_admin_access(auth, 'orgs');
    }

    private async _require_org_admin(auth: AuthContext, org_id: string): Promise<void> {
        this._require_auth(auth);
        if (auth.user!.role === 'admin') return;

        // Use new permission system when role_id is backfilled
        const { require_permission } = await import('../auth/permissions.js');
        await require_permission(org_id, auth.user!.id, 'org.members.manage', {
            site_role: auth.user!.role,
        });
    }

    /** Member or site admin may list/get roles for an org. */
    async assert_org_member_or_admin(auth: AuthContext, org_id: string): Promise<void> {
        this._require_auth(auth);
        if (auth.user!.role === 'admin') return;
        const membership = await this._org_member_repo.find_by_org_and_user(org_id, auth.user!.id);
        if (!membership) throw new ApiError('forbidden', 'You are not a member of this org', 403);
    }

    // ─── Unified list (replaces list_my_orgs + admin_list_orgs) ─────

    async get(auth: AuthContext, params: { search?: string; limit?: number; offset?: number; exclude_personal?: boolean; mine?: boolean }) {
        this._require_auth(auth);

        if (auth.user!.role === 'admin' && !params.mine) {
            return this._get_admin(auth, params);
        }

        const orgs = await this._org_member_repo.list_my_orgs(auth.user!.id);
        return { orgs };
    }

    private async _get_admin(_auth: AuthContext, params: { search?: string; limit?: number; offset?: number; exclude_personal?: boolean }) {
        const limit = Math.min(params.limit || 50, 100);
        const offset = params.offset || 0;

        const where: Record<string, unknown> = {};
        if (params.search) {
            where[Op.or as unknown as string] = [
                { slug: { [Op.iLike]: `%${escape_like(params.search)}%` } },
                { display_name: { [Op.iLike]: `%${escape_like(params.search)}%` } },
            ];
        }
        if (params.exclude_personal) {
            where.id = {
                [Op.notIn]: literal('(SELECT o.id FROM orgs o INNER JOIN users u ON lower(u.username) = lower(o.slug))'),
            };
        }

        const total = await Org.count({ where });

        const order_clause: Array<[any, string]> = params.search
            ? [[literal(`(slug = '${params.search.toLowerCase().replace(/'/g, "''")}')`), 'DESC'], ['created_at', 'DESC']]
            : [['created_at', 'DESC']];

        const orgs = await Org.findAll({
            where,
            attributes: [
                'id', 'slug', 'display_name',
                [literal('(SELECT count(*) FROM org_members om WHERE om.org_id = "Org"."id")'), 'member_count'],
                [literal('(SELECT count(*) FROM scopes s WHERE s.org_id = "Org"."id")'), 'scope_count'],
                'created_at',
            ],
            order: order_clause,
            limit,
            offset,
            raw: true,
        });

        return { orgs, total, limit, offset };
    }

    // ─── Get org by ID ──────────────────────────────────────────────

    async get_by_id(auth: AuthContext, params: { org_id: string }) {
        this._require_auth(auth);

        let my_role: string = 'member';
        if (auth.user!.role === 'admin') {
            my_role = 'site_admin';
        }
        if (my_role !== 'site_admin') {
            const membership = await this._org_member_repo.find_by_org_and_user(params.org_id, auth.user!.id);
            if (!membership) throw new ApiError('forbidden', 'You are not a member of this org', 403);
            my_role = membership.role;
        }

        const org = await this._org_repo.find_by_id(params.org_id);
        if (!org) throw new ApiError('not_found', 'Org not found', 404);

        const members = await this._org_member_repo.list_members_by_org(params.org_id);
        const { OrgRoleService } = await import('./org_role_service.js');
        const roles = await OrgRoleService.list(params.org_id);
        const { ALL_PERMISSIONS, OWNER_ONLY_PERMISSIONS } = await import('../auth/permissions.js');

        const scopes = await Scope.findAll({
            where: { org_id: params.org_id },
            attributes: [
                'id', 'slug', 'display_name', 'visibility',
                [literal('(SELECT count(*) FROM scope_members sm WHERE sm.scope_id = "Scope"."id")'), 'member_count'],
                [literal('(SELECT count(*) FROM teams t WHERE t.scope = "Scope"."slug")'), 'team_count'],
            ],
            order: [['slug', 'ASC']],
            raw: true,
        });

        return {
            ...org,
            my_role,
            members,
            scopes,
            roles,
            available_permissions: [...ALL_PERMISSIONS],
            owner_only_permissions: [...OWNER_ONLY_PERMISSIONS],
        };
    }

    /**
     * Org-scoped picker targets for HUG reviewers / dispatch destinations:
     * notification channels (and users when wired). Caller must be an org member.
     */
    async get_reviewable_targets(
        auth: AuthContext,
        params: { org_id?: string; query?: string },
    ): Promise<{ users: Array<{ username: string; display_name?: string }>; channels: Array<{ id: string; name: string }> }> {
        this._require_auth(auth);

        const org_id = params.org_id
            ?? auth.current_org_id
            ?? auth.org_ids?.[0]
            ?? null;
        if (!org_id) throw new ApiError('invalid_params', 'org_id is required', 400);

        await this.assert_org_member_or_admin(auth, org_id);

        const query = (params.query ?? '').trim().toLowerCase();
        const { NotificationChannel } = await import('../models/index.js');
        const channel_where: Record<string, unknown> = {
            org_id,
            enabled: 1,
        };
        if (query) {
            channel_where.name = { [Op.iLike]: `%${query}%` };
        }
        const channel_rows = await NotificationChannel.findAll({
            where: channel_where,
            attributes: ['id', 'name'],
            order: [['name', 'ASC']],
            limit: 100,
        });

        return {
            users: [],
            channels: channel_rows.map((c) => ({ id: c.id, name: c.name })),
        };
    }

    // ─── Create org (admin only) ───────

    async new_org(auth: AuthContext, params: {
        slug: string; display_name?: string; admin_username: string;
        admin_email?: string; admin_password?: string; admin_display_name?: string;
    }) {
        this._require_admin(auth);

        const slug = params.slug.toLowerCase();
        if (!SLUG_PATTERN.test(slug)) throw new ApiError('invalid_params', 'Slug must start with a letter and contain only lowercase letters, numbers, and hyphens', 422);
        if (RESERVED_SCOPES.includes(slug)) throw new ApiError('invalid_params', `Slug '${slug}' is reserved`, 422);

        const existing_org = await this._org_repo.find_by_slug(slug);
        if (existing_org) throw new ApiError('conflict', 'An org with that slug already exists', 409);

        const existing_scope = await this._scope_repo.find_by_slug(slug);
        if (existing_scope) throw new ApiError('conflict', 'A scope with that slug already exists', 409);

        const existing_user = await this._user_repo.find_by_username(slug);
        if (existing_user) throw new ApiError('conflict', 'That name is already taken by a user', 409);

        const uname = params.admin_username.toLowerCase();
        let admin_user = await User.findOne({ where: { username: uname }, attributes: ['id', 'username'], raw: true });

        if (!admin_user) {
            if (!params.admin_email || !params.admin_password) {
                throw new ApiError('not_found', `User '${uname}' not found. Provide admin_email and admin_password to create them.`, 404);
            }
            if (params.admin_password.length < MIN_PASSWORD_LENGTH) {
                throw new ApiError('invalid_params', 'Password must be at least 8 characters', 422);
            }
            if (!SLUG_PATTERN.test(uname)) throw new ApiError('invalid_params', 'Username must start with a letter and contain only lowercase letters, numbers, and hyphens', 422);
            if (RESERVED_SCOPES.includes(uname)) throw new ApiError('invalid_params', `Username '${uname}' is reserved`, 422);

            const trimmed_email = params.admin_email.trim().toLowerCase();
            if (!EMAIL_PATTERN.test(trimmed_email)) throw new ApiError('invalid_params', 'Invalid email address', 422);

            const email_conflict = await this._user_repo.find_by_email(trimmed_email);
            if (email_conflict) throw new ApiError('conflict', 'Email already in use', 409);

            const pw_hash = await hash_password(params.admin_password);
            const display = params.admin_display_name?.trim() || uname;

            const new_user = await User.create({
                username: uname,
                email: trimmed_email,
                password_hash: pw_hash,
                display_name: display,
                role: 'user',
            });
            await Scope.create({
                slug: uname,
                display_name: display,
                owner_id: new_user.id,
                visibility: 'public',
                scope_type: 'user',
            });

            if (this._audit_repo) {
                await this._audit_repo.create(auth.user!.id, 'user.create', 'user', new_user.id, { username: uname, via: 'org_create' });
            }
            admin_user = { id: new_user.id, username: uname } as any;
        }

        const display_name = params.display_name || slug;
        const org = await Org.create({ slug, display_name });
        const org_id = org.id;

        await seed_default_roles_for_org(org_id);
        const owner_role = await OrgRole.findOne({ where: { org_id, slug: 'owner' } });
        await OrgMember.create({
            org_id, user_id: admin_user!.id, role: 'admin',
            role_id: owner_role?.id ?? null,
        });

        // Default org scope (registry namespace = org slug)
        const scope = await Scope.create({
            slug,
            display_name,
            owner_id: admin_user!.id,
            visibility: 'public',
            scope_type: 'org',
            org_id,
        });
        await ScopeMember.create({ scope_id: scope.id, user_id: admin_user!.id });

        await Org.update(
            { default_scope_id: scope.id },
            { where: { id: org_id } },
        );

        await RealmService.ensure_org_default_realm(slug, String(admin_user!.id));

        // Ensure the admin also has a personal org + default realm — a shared
        // org membership is not a substitute for a personal namespace. Handles
        // both fresh new admins and existing users creating another org.
        await RealmService.ensure_personal_realm(
            String(admin_user!.id),
            admin_user!.username,
        );

        if (this._audit_repo) {
            await this._audit_repo.create(auth.user!.id, 'org.create', 'org', slug, {
                admin_user_id: admin_user!.id,
                admin_username: admin_user!.username,
                scope_id: scope.id,
            });
        }

        return {
            id: org_id,
            slug,
            scope_id: scope.id,
            scope_slug: scope.slug,
            default_scope_id: scope.id,
        };
    }

    // ─── Update org ─────────────────────────────────────────────────

    async update(auth: AuthContext, params: { org_id: string; display_name: string }) {
        await this._require_org_admin(auth, params.org_id);
        await this._org_repo.update_display_name(params.org_id, params.display_name);
        return { updated: true };
    }

    // ─── Delete org (admin only) ───────

    async delete_org(auth: AuthContext, params: { org_id: string }) {
        this._require_admin(auth);

        const org = await Org.findByPk(params.org_id, { attributes: ['id', 'slug'], raw: true });
        if (!org) throw new ApiError('not_found', 'Org not found', 404);

        const org_scopes = await Scope.findAll({ where: { org_id: org.id }, attributes: ['slug'], raw: true });
        const scope_slugs = org_scopes.map(s => s.slug);
        if (scope_slugs.length > 0) {
            const team_count = await Team.count({ where: { scope: { [Op.in]: scope_slugs } } });
            if (team_count > 0) {
                throw new ApiError('conflict', `Cannot delete org with ${team_count} team(s) — delete or transfer teams first`, 409);
            }
        }

        await ScopeMember.destroy({ where: { scope_id: await Scope.findAll({ where: { org_id: org.id }, attributes: ['id'], raw: true }).then(s => s.map(r => r.id)) } });
        await Scope.destroy({ where: { org_id: org.id } });
        await OrgMember.destroy({ where: { org_id: org.id } });
        await Org.destroy({ where: { id: org.id } });

        if (this._audit_repo) {
            await this._audit_repo.create(auth.user!.id, 'org.delete', 'org', org.slug, {});
        }

        return { deleted: true };
    }

    // ─── Member management ──────────────────────────────────────────

    async add_member(auth: AuthContext, params: {
        org_id: string;
        username?: string;
        email?: string;
        user_id?: string;
    }) {
        await this._require_org_admin(auth, params.org_id);

        let user: { id: string; username: string } | null = null;
        if (params.user_id != null) {
            const found = await this._user_repo.find_by_id(params.user_id);
            if (found) user = { id: found.id, username: found.username };
        }
        if (!user && params.email) {
            const email_row = await this._user_repo.find_by_email(params.email.trim().toLowerCase());
            if (email_row) {
                const found = await this._user_repo.find_by_id(email_row.id);
                if (found) user = { id: found.id, username: found.username };
            }
        }
        if (!user && params.username) {
            const found = await this._user_repo.find_by_username(params.username);
            if (found) user = { id: found.id, username: found.username };
        }
        if (!user) throw new ApiError('not_found', 'User not found', 404);

        const existing = await this._org_member_repo.find_by_org_and_user(params.org_id, user.id);
        if (existing) throw new ApiError('conflict', 'User is already a member', 409);

        // Resolve the default 'member' role for assignment
        const member_role = await OrgRole.findOne({
            where: { org_id: params.org_id, slug: 'member' },
            attributes: ['id'],
        });
        await this._org_member_repo.create(params.org_id, user.id, 'member');
        if (member_role) {
            await OrgMember.update(
                { role_id: member_role.id },
                { where: { org_id: params.org_id, user_id: user.id } },
            );
        }

        const org = await Org.findByPk(params.org_id, { attributes: ['slug'], raw: true });
        if (org?.slug) {
            await RealmService.ensure_org_default_realm(
                org.slug,
                String(auth.user!.id),
                String(user.id),
            );
        }

        /** Create per-user in-app notification channel for the new membership (best-effort). */
        try {
            await ensure_per_user_channel(user.id, params.org_id, user.username);
        } catch {
            /* Non-fatal — channel will be created on next login or backfill. */
        }

        return { user_id: user.id, username: user.username, role: 'member' };
    }

    async remove_member(auth: AuthContext, params: { org_id: string; user_id: string }) {
        await this._require_org_admin(auth, params.org_id);
        const member = await this._org_member_repo.find_by_org_and_user(params.org_id, params.user_id);
        if (!member) throw new ApiError('not_found', 'Member not found', 404);

        if (member.role === 'admin') {
            const admin_count = await this._org_member_repo.count_admins_by_org(params.org_id);
            if (admin_count <= 1) throw new ApiError('conflict', 'Cannot remove the last org admin', 409);
        }

        await this._scope_member_repo.delete_by_user_and_org_scopes(params.user_id, params.org_id);
        await this._org_member_repo.delete_by_org_and_user(params.org_id, params.user_id);

        // Revoke membership from all org realms
        await OrgRealmSyncService.sync_member_removed(params.org_id, params.user_id);

        /** Delete personal notification channel — CASCADE removes its destinations. */
        try {
            const { NotificationChannel } = await import('../models/index.js');
            await NotificationChannel.destroy({
                where: { user_id: params.user_id, org_id: params.org_id },
            });
        } catch {
            /* Best-effort — channel may not exist. */
        }

        return { removed: true };
    }

    async leave(auth: AuthContext, params: { org_id: string }) {
        this._require_auth(auth);
        const membership = await this._org_member_repo.find_by_org_and_user(params.org_id, auth.user!.id);
        if (!membership) throw new ApiError('not_found', 'You are not a member of this org', 404);

        if (membership.role === 'admin') {
            const admin_count = await this._org_member_repo.count_admins_by_org(params.org_id);
            if (admin_count <= 1) throw new ApiError('conflict', 'Cannot leave as the last org admin — promote someone else first', 409);
        }

        await this._scope_member_repo.delete_by_user_and_org_scopes(auth.user!.id, params.org_id);
        await this._org_member_repo.delete_by_org_and_user(params.org_id, auth.user!.id);

        // Revoke realm memberships
        await OrgRealmSyncService.sync_member_removed(params.org_id, auth.user!.id);

        return { left: true };
    }

    // ─── Scope management ───────────────────────────────────────────

    async new_scope(auth: AuthContext, params: { org_id: string; slug: string; display_name?: string; visibility?: 'public' | 'private' }) {
        await this._require_org_admin(auth, params.org_id);
        const org = await this._org_repo.find_by_id(params.org_id);
        if (!org) throw new ApiError('not_found', 'Org not found', 404);

        const slug = params.slug.toLowerCase();
        if (!SLUG_PATTERN.test(slug)) throw new ApiError('invalid_params', 'Slug must start with a letter and contain only lowercase letters, numbers, and hyphens', 422);
        if (slug !== org.slug && !slug.startsWith(org.slug + '-')) {
            throw new ApiError('invalid_params', `Scope slug must be '${org.slug}' or start with '${org.slug}-'`, 422);
        }
        if (RESERVED_SCOPES.includes(slug)) throw new ApiError('invalid_params', `Scope '${slug}' is reserved`, 422);

        const existing = await this._scope_repo.find_by_slug(slug);
        if (existing) throw new ApiError('conflict', 'A scope with that slug already exists', 409);

        const display_name = params.display_name || slug;
        const visibility = params.visibility || 'public';
        const scope_id = await this._scope_repo.create(slug, display_name, auth.user!.id, visibility, 'org', undefined, params.org_id);

        const admins = await this._org_member_repo.list_admins_by_org(params.org_id);
        for (const a of admins) {
            await this._scope_member_repo.create_on_conflict_ignore(scope_id, a.user_id);
        }

        return { id: scope_id, slug };
    }

    async delete_scope(auth: AuthContext, params: { org_id: string; scope_id: string }) {
        await this._require_org_admin(auth, params.org_id);
        const scope = await Scope.findOne({
            where: { id: params.scope_id, org_id: params.org_id },
            attributes: ['id', 'slug', 'org_id'],
            raw: true,
        });
        if (!scope) throw new ApiError('not_found', 'Scope not found in this org', 404);

        const org = await this._org_repo.find_by_id(params.org_id);
        if (org && scope.slug === org.slug) {
            throw new ApiError('conflict', 'Cannot delete the default org scope', 409);
        }

        const team_rows = await this._team_repo.list_by_scope(scope.slug);
        if (team_rows.length > 0) {
            throw new ApiError('conflict', `Cannot delete scope with ${team_rows.length} team(s)`, 409);
        }

        await this._scope_member_repo.delete_by_scope_id(params.scope_id);
        await this._scope_repo.delete_by_id(params.scope_id);
        return { deleted: true };
    }

    async assign_scope_member(auth: AuthContext, params: { org_id: string; scope_id: string; user_id: string }) {
        await this._require_org_admin(auth, params.org_id);
        const scope = await Scope.findOne({
            where: { id: params.scope_id, org_id: params.org_id },
            attributes: ['id'],
            raw: true,
        });
        if (!scope) throw new ApiError('not_found', 'Scope not found in this org', 404);

        const member = await this._org_member_repo.find_by_org_and_user(params.org_id, params.user_id);
        if (!member) throw new ApiError('conflict', 'User is not a member of this org', 409);

        const existing = await this._scope_member_repo.find_by_scope_and_user(params.scope_id, params.user_id);
        if (existing) throw new ApiError('conflict', 'User is already assigned to this scope', 409);

        await this._scope_member_repo.create(params.scope_id, params.user_id);
        return { assigned: true };
    }

    async unassign_scope_member(auth: AuthContext, params: { org_id: string; scope_id: string; user_id: string }) {
        await this._require_org_admin(auth, params.org_id);
        const scope = await Scope.findOne({
            where: { id: params.scope_id, org_id: params.org_id },
            attributes: ['id'],
            raw: true,
        });
        if (!scope) throw new ApiError('not_found', 'Scope not found in this org', 404);

        const count = await this._scope_member_repo.delete_by_scope_and_user(params.scope_id, params.user_id);
        return { removed: count > 0 };
    }
}
