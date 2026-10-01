import { ApiError } from '../errors/api_error.js';
import { get_logger } from '../lib/log.js';
import { hash_password, verify_password } from '../auth/password.js';
import {
    RESERVED_SCOPES, PROTECTED_USERNAMES, SLUG_PATTERN,
    EMAIL_PATTERN, MIN_PASSWORD_LENGTH, type EnvConfig,
} from '../config/env.js';
import type { AuditRepository } from '../repositories/audit_repository.js';
import type { TokenRepository } from '../repositories/token_repository.js';
import type { AuthContext } from '../schemas/auth_types.js';
import { User } from '../models/user.model.js';
import { Org } from '../models/org.model.js';
import { Op, literal } from 'sequelize';
import { get_sequelize } from '../lib/sequelize.js';
import { UserRepository } from '../repositories/user_repository.js';
import { ApiTokenRepository } from '../repositories/api_token_repository.js';
import { ScopeRepository } from '../repositories/scope_repository.js';
import { TeamRepository } from '../repositories/team_repository.js';
import { DraftRepository } from '../repositories/draft_repository.js';
import { OrgMemberRepository } from '../repositories/org_member_repository.js';
import { OrgRepository } from '../repositories/org_repository.js';
import { OrgRoleRepository } from '../repositories/org_role_repository.js';

const _user_repo_us = new UserRepository();
const _api_token_repo_us = new ApiTokenRepository();
const _scope_repo_us = new ScopeRepository();
const _team_repo_us = new TeamRepository();
const _draft_repo = new DraftRepository();
const _org_member_repo_us = new OrgMemberRepository();
const _org_repo_us = new OrgRepository();
const _org_role_repo_us = new OrgRoleRepository();
import { assert_access, assert_admin_access } from '../auth/assert_grant.js';
import { RealmService } from '../services/realm.service.js';

const log = get_logger('svc.users');

function escape_like(input: string): string {
    return input.replace(/[%_\\]/g, '\\$&');
}

export class UsersService {
    constructor(
        private _user_repo: UserRepository,
        private _scope_repo: ScopeRepository,
        private _token_repo: TokenRepository,
        private _audit_repo: AuditRepository,
        private _org_member_repo: OrgMemberRepository,
        private _config: EnvConfig,
    ) {}

    private _require_auth(auth: AuthContext) {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
    }

    private _require_admin(auth: AuthContext) {
        this._require_auth(auth);
        assert_admin_access(auth, 'users');
    }

    /**
     * Site admin, or account (org) admin of a shared org with the target.
     * Site admins cannot be managed by org admins.
     */
    private async _assert_can_manage_user(auth: AuthContext, target_id: string): Promise<void> {
        this._require_auth(auth);

        if (auth.user!.role === 'admin') return;

        if (auth.user!.id === target_id) return;

        const target = await _user_repo_us.find_by_id(target_id, {
            attributes: ['id', 'role'],
            raw: true,
        });
        if (!target) throw new ApiError('not_found', 'User not found', 404);
        if (target.role === 'admin') {
            throw new ApiError('forbidden', 'Cannot manage site admins', 403);
        }

        const admin_orgs = await _org_member_repo_us.find_all_q({
            where: { user_id: auth.user!.id, role: 'admin' },
            attributes: ['org_id'],
            raw: true,
        });
        if (admin_orgs.length === 0) {
            throw new ApiError('forbidden', 'Account admin access required', 403);
        }

        const shared = await _org_member_repo_us.find_one_q({
            where: {
                user_id: target_id,
                org_id: { [Op.in]: admin_orgs.map((row) => row.org_id) },
            },
            attributes: ['org_id'],
            raw: true,
        });
        if (!shared) {
            throw new ApiError('forbidden', 'Account admin access required for this user', 403);
        }
    }

    // ── List users ──────────────────────────────────────────────────

    async get(auth: AuthContext, params: {
        org_id?: string;
        realm_id?: string;
        search?: string;
        role?: 'user' | 'admin';
        suspended?: boolean;
        limit?: number;
        offset?: number;
    }) {
        log.debug('get', { user_id: auth.user?.id, org_id: params.org_id });
        this._require_auth(auth);

        if (params.realm_id) {
            const users = await RealmService.search_users(
                params.realm_id,
                String(auth.user!.id),
                params.search ?? '',
                params.limit ?? 20,
            );
            return { users, total: users.length, limit: params.limit ?? 20, offset: 0 };
        }

        if (params.org_id) {
            return this._get_org_members(auth, params.org_id, params);
        }

        this._require_admin(auth);

        const limit = Math.min(params.limit || 50, 100);
        const offset = params.offset || 0;

        const where: any = {};
        if (params.search) {
            const pattern = `%${escape_like(params.search)}%`;
            where[Op.or] = [
                { username: { [Op.iLike]: pattern } },
                { email: { [Op.iLike]: pattern } },
            ];
        }
        if (params.role) where.role = params.role;
        if (params.suspended === true) where.suspended_at = { [Op.ne]: null };
        if (params.suspended === false) where.suspended_at = null;

        const total = await _user_repo_us.find_count_q({ where });

        const safe_search = params.search?.toLowerCase().replace(/'/g, "''") ?? '';
        const order: any[] = params.search
            ? [[literal(`(username = '${safe_search}')`), 'DESC'], ['created_at', 'DESC']]
            : [['created_at', 'DESC']];

        const users = await _user_repo_us.find_all_q({
            where,
            attributes: ['id', 'username', 'display_name', 'email', 'role', 'suspended_at', 'created_at'],
            order,
            limit,
            offset,
            raw: true,
        });

        return { users, total, limit, offset };
    }

    private async _get_org_members(auth: AuthContext, org_id: string, params: { search?: string; limit?: number; offset?: number }) {
        const is_site_admin = auth.user!.role === 'admin';
        if (!is_site_admin) {
            const membership = await this._org_member_repo.find_by_org_and_user(org_id, auth.user!.id);
            if (!membership) {
                throw new ApiError('forbidden', 'Org membership required', 403);
            }
        }

        const limit = Math.min(params.limit || 50, 100);
        const offset = params.offset || 0;

        const include_where: any = {};
        if (params.search) {
            const pattern = `%${escape_like(params.search)}%`;
            include_where[Op.or] = [
                { username: { [Op.iLike]: pattern } },
                { email: { [Op.iLike]: pattern } },
            ];
        }

        const { count: total, rows } = await _org_member_repo_us.find_and_count_q({
            where: { org_id },
            include: [{
                model: User,
                attributes: ['id', 'username', 'display_name', 'email', 'role', 'suspended_at', 'created_at'],
                where: Object.keys(include_where).length > 0 ? include_where : undefined,
            }],
            limit,
            offset,
            order: [[User, 'created_at', 'DESC']],
            raw: true,
            nest: true,
        });

        const users = rows.map((row: any) => ({
            ...row.User,
            org_role: row.role,
        }));

        return { users, total, limit, offset };
    }

    // ── Get user by ID ──────────────────────────────────────────────

    async get_by_id(auth: AuthContext, params: {
        user_id: string;
        include_preferences?: boolean;
    }) {
        log.debug('get_by_id', { user_id: params.user_id });
        await this._assert_can_manage_user(auth, params.user_id);

        const attributes = [
            'id', 'username', 'display_name', 'email', 'role',
            'suspended_at', 'suspended_reason', 'created_at',
            ...(params.include_preferences ? ['preferences'] as const : []),
        ];

        const user = await _user_repo_us.find_by_id(params.user_id, {
            attributes: [...attributes],
            raw: true,
        });
        if (!user) throw new ApiError('not_found', 'User not found', 404);

        const [scope_count, team_count, token_count, draft_count, org_rows] = await Promise.all([
            _scope_repo_us.find_count_q({ where: { owner_id: user.id } }),
            _team_repo_us.find_count_q({ where: { author_id: user.id } }),
            _api_token_repo_us.find_count_q({ where: { user_id: user.id } }),
            _draft_repo.find_count_q({ where: { user_id: user.id } }),
            _org_member_repo_us.find_all_q({
                where: { user_id: user.id },
                include: [{ model: Org, attributes: ['id', 'slug', 'display_name'] }],
                raw: true,
                nest: true,
            }),
        ]);

        const orgs = org_rows.map((row: any) => ({
            ...row.Org,
            role: row.role,
        }));

        const result: Record<string, unknown> = {
            ...user,
            scope_count,
            team_count,
            token_count,
            draft_count,
            orgs,
        };

        if (params.include_preferences) {
            result.preferences = (user as { preferences?: Record<string, unknown> }).preferences ?? {};
        }

        return result;
    }

    // ── Create user ─────────────────────────────────────────────────

    async new_user(auth: AuthContext, params: {
        username: string;
        email: string;
        password: string;
        display_name?: string;
        role?: 'user' | 'admin';
    }) {
        log.debug('new_user', { username: params.username });
        // Route policy: site admin.
        this._require_auth(auth);

        const { username, email, password } = params;
        const role = params.role ?? 'user';

        const slug = username.toLowerCase();
        if (!SLUG_PATTERN.test(slug)) {
            throw new ApiError('invalid_params', 'Username must start with a letter and contain only lowercase letters, numbers, and hyphens', 422);
        }

        if (RESERVED_SCOPES.includes(slug)) {
            throw new ApiError('invalid_params', `Username '${slug}' is reserved`, 422);
        }

        const trimmed_email = email.trim().toLowerCase();
        if (!EMAIL_PATTERN.test(trimmed_email)) {
            throw new ApiError('invalid_params', 'Invalid email address', 422);
        }

        if (password.length < MIN_PASSWORD_LENGTH) {
            throw new ApiError('invalid_params', 'Password must be at least 8 characters', 422);
        }

        const existing = await this._user_repo.find_by_username_or_email(slug, trimmed_email);
        if (existing) throw new ApiError('conflict', 'Username or email already taken', 409);

        const pw_hash = await hash_password(password);
        const display_name = params.display_name?.trim() || slug;

        const transaction = await get_sequelize().transaction();

        try {
            const user_id = await this._user_repo.create(
                slug, trimmed_email, pw_hash, display_name, transaction, role,
            );
            // Default personal scope (registry namespace); realms come from org / on-demand create
            await this._scope_repo.create(slug, display_name, user_id, 'public', 'user', transaction);
            await transaction.commit();

            await this._audit_repo.create(auth.user!.id, 'user.create', 'user', user_id, {
                username: slug,
                role,
            });

            const personal = await RealmService.ensure_personal_realm(String(user_id), slug);

            log.info('user_created', { user_id, username: slug });
            return {
                id: user_id,
                username: slug,
                role,
                scope_slug: slug,
                default_realm_id: personal.default_realm_id,
                default_realm_slug: personal.default_realm_slug,
                enroll_token: personal.enroll_token,
            };
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    }

    // ── Update user ─────────────────────────────────────────────────

    async update(auth: AuthContext, params: {
        user_id?: string;
        display_name?: string;
        email?: string;
        preferences?: Record<string, unknown>;
    }) {
        log.debug('update', { user_id: params.user_id ?? auth.user?.id });
        this._require_auth(auth);

        const target_id = params.user_id || auth.user!.id;
        const is_self = target_id === auth.user!.id;

        if (!is_self) {
            await this._assert_can_manage_user(auth, target_id);
        }

        const updates: { display_name?: string; email?: string } = {};

        if (params.display_name !== undefined) {
            const trimmed = params.display_name.trim();
            if (trimmed.length < 1 || trimmed.length > 100) {
                throw new ApiError('invalid_params', 'Display name must be 1-100 characters', 422);
            }
            updates.display_name = trimmed;
        }

        if (params.email !== undefined) {
            const norm = params.email.trim().toLowerCase();
            if (!norm || !EMAIL_PATTERN.test(norm)) {
                throw new ApiError('invalid_params', 'Invalid email format', 422);
            }
            const existing = await this._user_repo.find_by_email(norm, target_id);
            if (existing) {
                throw new ApiError('conflict', 'Email already in use', 409);
            }
            updates.email = norm;
        }

        let profile_updated = false;
        if (Object.keys(updates).length > 0) {
            await this._user_repo.update_profile(target_id, updates);
            profile_updated = true;
        }

        let preferences: Record<string, unknown> | undefined;
        if (params.preferences !== undefined) {
            preferences = await this._user_repo.update_preferences(target_id, params.preferences);
        }

        if (!profile_updated && preferences === undefined) {
            return { updated: false };
        }

        if (!is_self) {
            const user = await this._user_repo.find_profile_by_id(target_id);
            await this._audit_repo.create(auth.user!.id, 'user.update', 'user', target_id, {
                username: user?.username,
                ...updates,
                preferences_patched: preferences !== undefined,
            });
        }

        const user = await this._user_repo.find_profile_by_id(target_id);
        return { updated: true, user };
    }

    // ── Delete user ─────────────────────────────────────────────────

    async delete(auth: AuthContext, params: { user_id: string }) {
        log.debug('delete', { user_id: params.user_id });
        // Route policy: site admin.
        this._require_auth(auth);

        if (params.user_id === auth.user!.id) throw new ApiError('invalid_params', 'Cannot delete yourself', 422);

        const user = await _user_repo_us.find_by_id(params.user_id, { attributes: ['id', 'username'], raw: true });
        if (!user) throw new ApiError('not_found', 'User not found', 404);

        if (PROTECTED_USERNAMES.includes(user.username)) {
            throw new ApiError('invalid_params', `User '${user.username}' is protected and cannot be deleted`, 422);
        }

        const [team_count, draft_count, token_count, scope_count] = await Promise.all([
            _team_repo_us.find_count_q({ where: { author_id: user.id } }),
            _draft_repo.find_count_q({ where: { user_id: user.id } }),
            _api_token_repo_us.find_count_q({ where: { user_id: user.id } }),
            _scope_repo_us.find_count_q({ where: { owner_id: user.id } }),
        ]);

        await _user_repo_us.delete_where_q({ where: { id: user.id } });

        await this._audit_repo.create(auth.user!.id, 'user.delete', 'user', user.id, {
            username: user.username,
            teams_deleted: team_count,
            drafts_deleted: draft_count,
            tokens_deleted: token_count,
            scopes_deleted: scope_count,
        });

        log.info('user_deleted', { user_id: params.user_id, username: user.username });
        return { deleted: true };
    }

    // ── Suspend / Unsuspend ─────────────────────────────────────────

    async suspend(auth: AuthContext, params: { user_id: string; reason?: string }) {
        log.debug('suspend', { user_id: params.user_id });
        // Route policy: site admin.
        this._require_auth(auth);

        if (params.user_id === auth.user!.id) throw new ApiError('invalid_params', 'Cannot suspend yourself', 422);

        const user = await _user_repo_us.find_by_id(params.user_id, { attributes: ['id', 'username'], raw: true });
        if (!user) throw new ApiError('not_found', 'User not found', 404);

        if (PROTECTED_USERNAMES.includes(user.username)) {
            throw new ApiError('invalid_params', `User '${user.username}' is protected and cannot be suspended`, 422);
        }

        const reason = params.reason || '';
        await _user_repo_us.update_where(
            { id: user.id } as any,
            { suspended_at: new Date(), suspended_reason: reason } as any,
        );

        await this._audit_repo.create(auth.user!.id, 'user.suspend', 'user', user.id, { username: user.username, reason });

        log.info('user_suspended', { user_id: params.user_id, username: user.username });
        return { suspended: true };
    }

    async unsuspend(auth: AuthContext, params: { user_id: string }) {
        log.debug('unsuspend', { user_id: params.user_id });
        // Route policy: site admin.
        this._require_auth(auth);

        const user = await _user_repo_us.find_by_id(params.user_id, { attributes: ['id', 'username'], raw: true });
        if (!user) throw new ApiError('not_found', 'User not found', 404);

        await _user_repo_us.update_where(
            { id: user.id } as any,
            { suspended_at: null, suspended_reason: '' } as any,
        );

        await this._audit_repo.create(auth.user!.id, 'user.unsuspend', 'user', user.id, { username: user.username });

        log.info('user_unsuspended', { user_id: params.user_id, username: user.username });
        return { suspended: false };
    }

    // ── Reset password ──────────────────────────────────────────────

    async reset_password(auth: AuthContext, params: { user_id: string; new_password: string }) {
        log.debug('reset_password', { user_id: params.user_id });
        // Route policy: site admin (org admins do not reset passwords).
        this._require_auth(auth);

        if (params.new_password.length < MIN_PASSWORD_LENGTH) {
            throw new ApiError('invalid_params', 'Password must be at least 8 characters', 422);
        }

        const user = await _user_repo_us.find_by_id(params.user_id, { attributes: ['id', 'username'], raw: true });
        if (!user) throw new ApiError('not_found', 'User not found', 404);

        const pw_hash = await hash_password(params.new_password);
        await _user_repo_us.update_where({ id: user.id } as any, { password_hash: pw_hash } as any);

        await this._audit_repo.create(auth.user!.id, 'user.reset_password', 'user', user.id, { username: user.username });

        return { reset: true };
    }

    // ── Set role ────────────────────────────────────────────────────

    async set_role(auth: AuthContext, params: { user_id: string; role: 'user' | 'admin' }) {
        log.debug('set_role', { user_id: params.user_id, role: params.role });
        // Route policy: site admin.
        this._require_auth(auth);

        if (params.user_id === auth.user!.id && params.role !== 'admin') {
            throw new ApiError('invalid_params', 'Cannot demote yourself', 422);
        }

        const user = await _user_repo_us.find_by_id(params.user_id, { attributes: ['id', 'username', 'role'], raw: true });
        if (!user) throw new ApiError('not_found', 'User not found', 404);

        if (PROTECTED_USERNAMES.includes(user.username) && params.role !== 'admin') {
            throw new ApiError('invalid_params', `User '${user.username}' is protected and cannot be demoted`, 422);
        }

        if (user.role === 'admin' && params.role === 'user') {
            const admin_count = await _user_repo_us.find_count_q({ where: { role: 'admin' } });
            if (admin_count <= 1) throw new ApiError('invalid_params', 'Cannot remove the last admin', 422);
        }

        const old_role = user.role;
        await _user_repo_us.update_where({ id: user.id } as any, { role: params.role } as any);

        await this._audit_repo.create(auth.user!.id, 'user.set_role', 'user', user.id, {
            username: user.username,
            from: old_role,
            to: params.role,
        });

        return { role: params.role };
    }

    /**
     * Assign an org role definition to a member.
     * Replaces /internal/orgs/set_member_role.
     */
    async update_role(auth: AuthContext, params: {
        user_id: string;
        org_id: string;
        role_id: string;
    }) {
        log.debug('update_role', { user_id: params.user_id, org_id: params.org_id, role_id: params.role_id });
        this._require_auth(auth);

        // Route policy: org.members.manage in org_id.
        const member = await this._org_member_repo.find_by_org_and_user(params.org_id, params.user_id);
        if (!member) throw new ApiError('not_found', 'Member not found', 404);

        const target_role = await _org_role_repo_us.find_one_q({
            where: { id: params.role_id, org_id: params.org_id },
        });
        if (!target_role) throw new ApiError('not_found', 'Role not found in this org', 404);
        if (target_role.is_system) {
            throw new ApiError(
                'forbidden',
                'Cannot assign the owner role — ownership is transferred explicitly',
                403,
            );
        }

        // Last-owner protection: do not demote the last member on the system owner role.
        if (member.role_id) {
            const current_role = await _org_role_repo_us.find_one_q({
                where: { id: member.role_id, org_id: params.org_id },
            });
            if (current_role?.is_system && current_role.id !== params.role_id) {
                const owner_count = await _org_member_repo_us.find_count_q({
                    where: { org_id: params.org_id, role_id: current_role.id },
                });
                if (owner_count <= 1) {
                    throw new ApiError('conflict', 'Cannot demote the last org owner', 409);
                }
            }
        } else if (member.role === 'admin') {
            // Legacy text-column fallback while role_id is null.
            const admin_count = await this._org_member_repo.count_admins_by_org(params.org_id);
            if (admin_count <= 1 && target_role.slug !== 'admin') {
                throw new ApiError('conflict', 'Cannot demote the last org admin', 409);
            }
        }

        // Keep deprecated text column in sync for legacy readers.
        const legacy_role = (target_role.slug === 'admin' || target_role.slug === 'owner')
            ? 'admin'
            : 'member';

        await _org_member_repo_us.update_where(
            { org_id: params.org_id, user_id: params.user_id } as any,
            { role_id: params.role_id, role: legacy_role } as any,
        );

        return {
            user_id: params.user_id,
            org_id: params.org_id,
            role_id: params.role_id,
            role_slug: target_role.slug,
            role: legacy_role,
        };
    }

    // ── Change password (self) ──────────────────────────────────────

    async change_password(auth: AuthContext, params: { current_password: string; new_password: string }) {
        log.debug('change_password', { user_id: auth.user?.id });
        this._require_auth(auth);

        if (params.new_password.length < MIN_PASSWORD_LENGTH) {
            throw new ApiError('invalid_params', 'New password must be at least 8 characters', 422);
        }

        const hash = await this._user_repo.find_password_hash(auth.user!.id);
        if (!hash) throw new ApiError('not_found', 'User not found', 404);

        const valid = await verify_password(params.current_password, hash);
        if (!valid) throw new ApiError('forbidden', 'Current password is incorrect', 403);

        const new_hash = await hash_password(params.new_password);
        await this._user_repo.update_password(auth.user!.id, new_hash);

        return { message: 'Password changed' };
    }
}
