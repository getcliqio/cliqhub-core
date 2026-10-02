import { ApiError } from '../errors/api_error.js';
import { get_logger } from '../lib/log.js';
import { hash_password, verify_password } from '../auth/password.js';
import { PROTECTED_USERNAMES, type EnvConfig } from '../config/env.js';
import type { AuditRepository } from '../repositories/audit_repository.js';
import type { TokenRepository } from '../repositories/token_repository.js';
import type { AuthContext } from '../schemas/auth_types.js';
import { Op, literal } from 'sequelize';
import { UserRepository, user_list_status, type UserListStatus } from '../repositories/user_repository.js';
import { ApiTokenRepository } from '../repositories/api_token_repository.js';
import { ScopeRepository } from '../repositories/scope_repository.js';
import { TeamRepository } from '../repositories/team_repository.js';
import { DraftRepository } from '../repositories/draft_repository.js';
import { OrgMemberRepository } from '../repositories/org_member_repository.js';
import { OrgRepository } from '../repositories/org_repository.js';
import { OrgRoleRepository } from '../repositories/org_role_repository.js';
import { assert_access, assert_admin_access } from '../auth/assert_grant.js';
import { RealmService } from '../services/realm.service.js';
import { get_sequelize as get_db_sequelize } from '../db/sequelize.js';
import { orgs_blocking_user_delete, soft_delete_user, user_delete_blocker } from './namespace_removal.js';
import { assert_email_free, assert_namespace_free, deleted_user_error, on_name_race } from '../lib/namespace.js';
import { assert_password_rules, normalize_email, normalize_username } from '../lib/account_fields.js';
import { equals_first, list_order, nulls_last, type SortColumns, type SortDir } from '../lib/list_sort.js';
import { Org, Scope, User } from '../models/index.js';
import { ensure_account_org } from './account_org.js';
import { OrgEventService } from './org_event.service.js';
import { ReactivationService } from './reactivation.service.js';
import { PasswordLinkService } from './password_link.service.js';
import { resolve_delivery_links } from '../notifications/delivery_links.js';
import {
    USER_PASSWORD_CHANGED, USER_PASSWORD_RESET_SENT, USER_SETUP_SENT, type EventUser,
} from '../notifications/org_events.js';
import { escape_like } from '../lib/search.js';
import { run_in_background } from '../lib/background.js';

const _user_repo_us = new UserRepository();
const _api_token_repo_us = new ApiTokenRepository();
const _scope_repo_us = new ScopeRepository();
const _team_repo_us = new TeamRepository();
const _draft_repo = new DraftRepository();
const _org_member_repo_us = new OrgMemberRepository();
const _org_repo_us = new OrgRepository();
const _org_role_repo_us = new OrgRoleRepository();

const log = get_logger('svc.users');

/** `users/get` (site-admin hub list) sort keys. */
export type UserSortKey = 'username' | 'role' | 'created_at' | 'suspended_at';

/** `users/get` sort key → ORDER BY (never-suspended accounts sort last either way). */
const USER_SORT_COLUMNS: SortColumns<UserSortKey> = {
    username: (d) => [['username', d]],
    role: (d) => [['role', d]],
    created_at: (d) => [['created_at', d]],
    suspended_at: (d) => [['suspended_at', nulls_last(d)]],
};

/** User columns the password-link flows read (deleted rows included). */
const LINK_USER_ATTRS = ['id', 'username', 'email', 'display_name', 'status', 'deleted_at', 'suspended_at'] as const;

/** A user row as the password-link flows read it; `username` is null for a person invited by email. */
type LinkUserRow = Pick<User, 'id' | 'email' | 'display_name' | 'status' | 'deleted_at' | 'suspended_at'> & { username: string | null };

/** The `user` of a `user.*` event. */
function event_user(u: { id: string; username: string | null; email: string; display_name: string }): EventUser {
    return { id: u.id, username: u.username, email: u.email, display_name: u.display_name };
}

/** `details.id` of a `409 deleted` naming a user, else null. */
function deleted_user_id(err: unknown): string | null {
    if (!(err instanceof ApiError) || err.code !== 'deleted') return null;
    const details = err.details as { kind?: string; id?: string } | undefined;
    return details?.kind === 'user' && details.id ? details.id : null;
}

/** A user row with its list `status` (`deleted` once soft-deleted) and `deleted_at` as ISO. */
function with_list_status<T extends { status: string; deleted_at: Date | string | null }>(row: T): Omit<T, 'status' | 'deleted_at'> & { status: UserListStatus; deleted_at: string | null } {
    return {
        ...row,
        status: user_list_status(row),
        deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
    };
}

export class UsersService {
    constructor(
        private _user_repo: UserRepository,
        private _scope_repo: ScopeRepository,
        private _token_repo: TokenRepository,
        private _audit_repo: AuditRepository,
        private _org_member_repo: OrgMemberRepository,
        private _config: EnvConfig,
        private _reactivation: ReactivationService = new ReactivationService(),
        private _password_links: PasswordLinkService = new PasswordLinkService(),
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
            where: { user_id: auth.user!.id, role: 'admin', status: 'active', deleted_at: null },
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
                status: 'active',
                deleted_at: null,
            },
            attributes: ['org_id'],
            raw: true,
        });
        if (!shared) {
            throw new ApiError('forbidden', 'Account admin access required for this user', 403);
        }
    }

    // ── List users ──────────────────────────────────────────────────

    /**
     * `users/get`: realm invite search, an org's live members (`org_id`), or
     * the site-admin hub list. Every row carries `status` (`invited`,
     * `active`, `suspended` or `deleted`) and `deleted_at`. Deleted users are
     * listed only in the hub list with `include_deleted`.
     *
     * @throws ApiError 400 `sort_by` with org_id / realm_id; 403 not a member / not a site admin
     */
    async get(auth: AuthContext, params: {
        org_id?: string;
        realm_id?: string;
        search?: string;
        role?: 'user' | 'admin';
        suspended?: boolean;
        limit?: number;
        offset?: number;
        sort_by?: UserSortKey;
        sort_dir?: SortDir;
        include_deleted?: boolean;
    }) {
        log.debug('get', { user_id: auth.user?.id, org_id: params.org_id });
        this._require_auth(auth);
        // Realm invite search and org member lists keep their own order; sorting is for the hub list.
        if (params.sort_by && (params.realm_id || params.org_id)) {
            throw new ApiError('invalid_params', 'sort_by applies to the site-admin hub list only (not with org_id / realm_id)', 400);
        }

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
        if (!params.include_deleted) where.deleted_at = null;

        const total = await _user_repo_us.find_count_q({ where });

        // Default: an exact username match first when searching, then newest first.
        // The search value is a Sequelize value (escaped), never spliced into SQL text.
        const order = list_order(USER_SORT_COLUMNS, params, params.search
            ? [equals_first('username', params.search.toLowerCase()), ['created_at', 'DESC']]
            : [['created_at', 'DESC']]);

        const rows = await _user_repo_us.find_all_q({
            where,
            attributes: ['id', 'username', 'display_name', 'email', 'role', 'suspended_at', 'created_at', 'status', 'deleted_at'],
            order,
            limit,
            offset,
            raw: true,
        });

        return { users: rows.map(with_list_status), total, limit, offset };
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
            where: { org_id, status: 'active', deleted_at: null },
            include: [{
                model: User,
                attributes: ['id', 'username', 'display_name', 'email', 'role', 'suspended_at', 'created_at', 'status', 'deleted_at'],
                where: { ...include_where, deleted_at: null },
            }],
            limit,
            offset,
            order: [[User, 'created_at', 'DESC']],
            raw: true,
            nest: true,
        });

        const users = rows.map((row: any) => ({
            ...with_list_status(row.User),
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
            'suspended_at', 'suspended_reason', 'created_at', 'status', 'deleted_at',
            ...(params.include_preferences ? ['preferences'] as const : []),
        ];

        const found = await _user_repo_us.find_by_id(params.user_id, {
            attributes: [...attributes],
            raw: true,
        });
        // A deleted user is visible to site admins only.
        if (!found || (found.deleted_at && auth.user!.role !== 'admin')) throw new ApiError('not_found', 'User not found', 404);
        const user = with_list_status(found);

        const [scope_count, team_count, token_count, draft_count, org_rows] = await Promise.all([
            _scope_repo_us.find_count_q({ where: { owner_id: user.id } }),
            _team_repo_us.find_count_q({ where: { author_id: user.id } }),
            _api_token_repo_us.find_count_q({ where: { user_id: user.id } }),
            _draft_repo.find_count_q({ where: { user_id: user.id } }),
            _org_member_repo_us.find_all_q({
                where: { user_id: user.id, status: 'active', deleted_at: null },
                include: [{ model: Org, attributes: ['id', 'slug', 'display_name'], where: { deleted_at: null } }],
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

    /**
     * Creates a user who sets their own password: the user (`invited`, no
     * password), their user scope and account org (seeded with the default
     * channels and rules), and a "Set your password" link (7 days), in one
     * transaction; then raises `user.setup.sent` to the user's account org.
     *
     * With `reactivate: true`, a deleted user holding the username or email
     * is restored (same id), given the requested email, display name and role
     * (the email after the same conflict checks), and sent a new setup link.
     * A restored user keeps their username: asking for a different one is
     * refused.
     *
     * Route policy: site admin.
     *
     * @returns The user and the setup link's expiry; `setup_url` only when no email carried the link.
     * @throws ApiError 422 invalid username / email (or a different username
     *   for a restored user); 409 conflict (live holder, also when a
     *   concurrent create took a name); 409 deleted (deleted holder, without
     *   `reactivate`); whatever ReactivationService.restore_user throws (403
     *   for a non site admin)
     */
    async new_user(auth: AuthContext, params: {
        username: string;
        email: string;
        display_name?: string;
        role?: 'user' | 'admin';
        reactivate?: boolean;
    }) {
        log.debug('new_user', { username: params.username, reactivate: params.reactivate === true });
        this._require_auth(auth);

        const role = params.role ?? 'user';
        const slug = normalize_username(params.username);
        const email = normalize_email(params.email);
        const display_name = params.display_name?.trim() || slug;

        const restore = await this._deleted_user_to_restore(slug, email, params.reactivate === true);
        if (restore?.username && restore.username !== slug) {
            throw new ApiError('invalid_params', `${email} belongs to the deleted user ${restore.username}; reactivate them with that username`, 422, { field: 'username' });
        }
        const restore_id = restore?.id ?? null;

        const { pending, user, link, account_org_id } = await on_name_race(() => get_db_sequelize().transaction(async (t) => {
            let user_id: string;
            if (restore_id) {
                user_id = (await this._reactivation.restore_user(auth, restore_id, t)).id;
                // The request applies to the restored user (its names were checked above).
                await User.update(
                    { username: slug, email, role, ...(params.display_name?.trim() ? { display_name } : {}) },
                    { where: { id: user_id }, transaction: t },
                );
            } else {
                const created = await User.create(
                    { username: slug, email, display_name, role, status: 'invited', password_hash: null },
                    { transaction: t },
                );
                user_id = created.id;
            }
            // Default personal scope (registry namespace); realms come from org / on-demand create.
            if (!(await Scope.findOne({ where: { slug }, attributes: ['id'], raw: true, transaction: t }))) {
                await this._scope_repo.create(slug, display_name, user_id, 'public', 'user', t);
            }
            const row = await User.findByPk(user_id, {
                attributes: ['id', 'username', 'email', 'display_name', 'status'], raw: true, transaction: t,
            });
            if (!row) throw new ApiError('internal_error', 'Failed to read the created user', 500);
            const org_id = (await ensure_account_org(row.id, row.username, t)).id;

            const issued = await this._password_links.issue(row.id, 'setup', { requested_by: auth.user!.id, transaction: t });
            const raised = OrgEventService.raise_after_commit(t, {
                event: USER_SETUP_SENT,
                org_id,
                actor: { user_id: auth.user!.id },
                data: { user: event_user(row), reset_id: issued.id, expires_at: issued.expires_at.toISOString(), send_count: issued.send_count },
                link: { kind: 'password', reset_id: issued.id },
            });
            return { pending: raised, user: row, link: issued, account_org_id: org_id };
        }), async () => { await this._deleted_user_to_restore(slug, email, params.reactivate === true); });

        await this._audit_repo.create(auth.user!.id, restore_id ? 'user.reactivate' : 'user.create', 'user', user.id, {
            username: user.username,
            role,
        });
        if (!restore_id) await RealmService.ensure_personal_realm(String(user.id), user.username);

        const { email_sent } = await pending.result;
        const setup_url = email_sent ? null : (await resolve_delivery_links({ kind: 'password', reset_id: link.id })).setup_url ?? null;

        log.info('user_created', { user_id: user.id, username: user.username, account_org_id, reactivated: Boolean(restore_id), email_sent });
        return {
            user: { id: user.id, username: user.username, email: user.email, status: user.status },
            setup: { expires_at: link.expires_at.toISOString(), email_sent, setup_url },
        };
    }

    /**
     * Checks the username and email are free. A deleted user holding either
     * is returned for restoring when `reactivate` is set (one user only).
     *
     * @returns The deleted user to restore (id and username), or null to create a new user.
     * @throws ApiError 409 conflict (live holder); 409 deleted (without `reactivate`, a deleted org, or two different deleted users)
     */
    private async _deleted_user_to_restore(slug: string, email: string, reactivate: boolean): Promise<{ id: string; username: string | null } | null> {
        let restore_id: string | null = null;
        const checks = [
            // The username also becomes a scope and an account org: free in all three (lib/namespace.ts).
            () => assert_namespace_free(
                { org_repo: _org_repo_us, scope_repo: this._scope_repo, user_repo: this._user_repo },
                slug, ['user', 'org', 'scope'], 'username',
            ),
            () => assert_email_free(this._user_repo, email),
        ];
        for (const check of checks) {
            try {
                await check();
            } catch (err) {
                const deleted_user = deleted_user_id(err);
                if (!reactivate || !deleted_user || (restore_id && restore_id !== deleted_user)) throw err;
                restore_id = deleted_user;
            }
        }
        if (!restore_id) return null;
        const row = await User.findByPk(restore_id, { attributes: ['id', 'username'], raw: true });
        return { id: restore_id, username: row?.username ?? null };
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
            const norm = normalize_email(params.email);
            await assert_email_free(this._user_repo, norm, target_id);
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

    /**
     * Soft-deletes a user in one transaction ({@link soft_delete_user}): the
     * user and their account org keep their rows (username, email and org slug
     * stay taken), other memberships become former memberships, tokens and
     * pending invites they sent are revoked. History is kept. The account
     * org's realms are soft-deleted and their tokens revoked after commit.
     *
     * @throws ApiError 422 self-delete or a protected user; 404 unknown (or
     *   already deleted) user; 409 `owns_orgs` (details.orgs) when the user owns
     *   another org or their account org has another owner; 409 `conflict` when
     *   {@link user_delete_blocker} names a reason. Nothing is changed on a refusal.
     */
    async delete(auth: AuthContext, params: { user_id: string }) {
        log.debug('delete', { user_id: params.user_id });
        // Route policy: site admin.
        this._require_auth(auth);

        if (params.user_id === auth.user!.id) throw new ApiError('invalid_params', 'Cannot delete yourself', 422);

        const user = await _user_repo_us.find_one_q({ where: { id: params.user_id, deleted_at: null }, attributes: ['id', 'username'], raw: true });
        if (!user) throw new ApiError('not_found', 'User not found', 404);

        if (user.username && PROTECTED_USERNAMES.includes(user.username)) {
            throw new ApiError('invalid_params', `User '${user.username}' is protected and cannot be deleted`, 422);
        }

        const target = { id: String(user.id), username: user.username ?? null };
        const owned = await orgs_blocking_user_delete(target);
        if (owned.length) throw ApiError.owns_orgs(owned);
        const blocker = await user_delete_blocker(target);
        if (blocker) throw new ApiError('conflict', `Cannot delete user ${user.username ?? user.id}: ${blocker}`, 409);

        const removed = await get_db_sequelize().transaction(async (t) => {
            const out = await soft_delete_user(target, t);
            await this._audit_repo.create(auth.user!.id, 'user.delete', 'user', user.id, {
                username: user.username,
                account_org: out.account_org,
                realms: out.realms.map((r) => r.slug),
                org_memberships: out.org_memberships,
                realm_memberships: out.realm_memberships,
                tokens_revoked: out.tokens_revoked,
                invites_revoked: out.invites_revoked,
            }, t);
            return out;
        });
        await RealmService.after_org_realms_removed(removed.realms, String(auth.user!.id));

        log.info('user_deleted', { user_id: params.user_id, username: user.username, account_org: removed.account_org, realms: removed.realms.length });
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
        await User.update({ suspended_at: new Date(), suspended_reason: reason, status: 'suspended' }, { where: { id: user.id } });

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

        await User.update(
            // Back to invited when the person never set a password.
            { suspended_at: null, suspended_reason: '', status: literal(`CASE WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END`) },
            { where: { id: user.id } },
        );

        await this._audit_repo.create(auth.user!.id, 'user.unsuspend', 'user', user.id, { username: user.username });

        log.info('user_unsuspended', { user_id: params.user_id, username: user.username });
        return { suspended: false };
    }

    // ── Reset password ──────────────────────────────────────────────

    /**
     * Emails a user a password reset link (24 hours) on a site admin's
     * request. Asking again while a link is open sends the same link with a
     * new expiry. Existing sessions stay valid until the password changes.
     * Raises `user.password_reset.sent` to the user's account org.
     *
     * Route policy: site admin (the `{ user_id }` body).
     *
     * @returns The link's id and expiry; `reset_url` only when no email carried the link.
     * @throws ApiError 404 unknown user; 409 deleted; 409 not_active
     *   `{ status: 'suspended' }`, or `{ status: 'invited' }` for a person who has no username yet
     */
    async reset_password(auth: AuthContext, params: { user_id: string }) {
        log.debug('reset_password', { user_id: params.user_id });
        this._require_auth(auth);

        const user = await User.findByPk(params.user_id, { attributes: [...LINK_USER_ATTRS], raw: true });
        if (!user) throw new ApiError('not_found', 'User not found', 404);
        if (user.deleted_at) throw deleted_user_error({ ...user, deleted_at: user.deleted_at }, `User ${user.username ?? user.email} was deleted`);
        if (user.status === 'suspended' || user.suspended_at) throw ApiError.not_active('suspended', 'Unsuspend the user first.');
        if (!user.username) throw ApiError.not_active('invited', 'This person has not accepted their invite yet.');

        const link = await this._send_reset_link(user, auth.user!.id);
        await this._audit_repo.create(auth.user!.id, 'user.reset_password', 'user', user.id, { username: user.username });

        const reset_url = link.email_sent ? null : (await resolve_delivery_links({ kind: 'password', reset_id: link.id })).reset_url ?? null;
        return { reset_id: link.id, expires_at: link.expires_at.toISOString(), email_sent: link.email_sent, reset_url };
    }

    /**
     * Public "Forgot password": counts the request against the hourly
     * per-email limit, then answers at once. The reset
     * link is issued and emailed in the background, only for a live account
     * (active, or invited with a username), so neither the answer nor its
     * timing tells whether the email has an account.
     *
     * Route policy: public (the `{ email }` body).
     *
     * @param email - Normalized (trimmed, lowercase) email.
     * @returns Always `{ requested: true }`.
     * @throws ApiError 429 rate_limited
     */
    async forgot_password(params: { email: string }): Promise<{ requested: true }> {
        log.debug('forgot_password', {});
        await this._password_links.record_forgot_request(params.email);
        run_in_background('forgot_password', () => this.send_forgot_password_link(params.email));
        return { requested: true };
    }

    /**
     * The background half of {@link forgot_password}: issues (or sends again)
     * the reset link when the email belongs to a live account; does nothing
     * for unknown, deleted or suspended accounts and invited people without
     * a username.
     *
     * @returns Whether a link was sent.
     */
    async send_forgot_password_link(email: string): Promise<boolean> {
        const user = await User.findOne({ where: { email }, attributes: [...LINK_USER_ATTRS], raw: true });
        if (!user || user.deleted_at || user.suspended_at || user.status === 'suspended' || !user.username) {
            log.info('forgot_password_ignored', {});
            return false;
        }
        const link = await this._send_reset_link(user, null);
        log.info('forgot_password_sent', { user_id: user.id, email_sent: link.email_sent });
        return true;
    }

    /** Issues or re-sends the user's reset link and raises `user.password_reset.sent`. */
    private async _send_reset_link(user: LinkUserRow, requested_by: string | null) {
        const { pending, link } = await get_db_sequelize().transaction(async (t) => {
            const org_id = (await ensure_account_org(user.id, user.username!, t)).id;
            const issued = await this._password_links.issue(user.id, 'reset', { requested_by, transaction: t });
            const raised = OrgEventService.raise_after_commit(t, {
                event: USER_PASSWORD_RESET_SENT,
                org_id,
                actor: { user_id: requested_by ?? user.id },
                data: { user: event_user(user), reset_id: issued.id, expires_at: issued.expires_at.toISOString(), send_count: issued.send_count },
                link: { kind: 'password', reset_id: issued.id },
            });
            return { pending: raised, link: issued };
        });
        const { email_sent } = await pending.result;
        return { ...link, email_sent };
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
                    where: { org_id: params.org_id, role_id: current_role.id, status: 'active', deleted_at: null },
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

    // ── Change password ─────────────────────────────────────────────

    /**
     * Signed-in password change: checks the current password, sets the new
     * one, signs out the caller's other sessions, retires open password links
     * and raises `user.password.changed`.
     *
     * Route policy: signed in (self).
     *
     * @throws ApiError 422 new password too short; 403 current password wrong; 404 unknown user
     */
    async change_password(auth: AuthContext, params: { current_password: string; new_password: string }) {
        log.debug('change_password', { user_id: auth.user?.id });
        this._require_auth(auth);
        assert_password_rules(params.new_password);

        const hash = await this._user_repo.find_password_hash(auth.user!.id);
        if (!hash) throw new ApiError('not_found', 'User not found', 404);

        const valid = await verify_password(params.current_password, hash);
        if (!valid) throw new ApiError('forbidden', 'Current password is incorrect', 403);

        const new_hash = await hash_password(params.new_password);
        return this._set_password(auth.user!.id, new_hash, { except_session: auth.token_id });
    }

    /**
     * Password change from an emailed "Set your password" / "Reset your
     * password" link: the token is the credential. Sets the password,
     * activates an invited user, marks the link used (and retires the user's
     * other open links), signs out every session and raises
     * `user.password.changed`, all in one transaction.
     *
     * Route policy: public (the `{ reset_token }` body).
     *
     * @throws ApiError 422 new password too short; 404 not_found unknown link
     *   (or its user is gone); 409 not_pending `{ status: 'used' }`; 410 expired;
     *   409 not_active `{ status: 'suspended' }`
     */
    async change_password_with_token(params: { reset_token: string; new_password: string }) {
        log.debug('change_password_with_token', {});
        assert_password_rules(params.new_password);
        // The link is checked before the (slow) hash; redeeming it below checks it again under a lock.
        await this._password_links.assert_open(params.reset_token);
        const new_hash = await hash_password(params.new_password);
        return this._set_password(null, new_hash, { reset_token: params.reset_token });
    }

    /**
     * Sets a password inside one transaction, redeeming `reset_token` first
     * when given (then the link names the user).
     */
    private async _set_password(
        user_id: string | null,
        password_hash: string,
        opts: { reset_token?: string; except_session?: string },
    ) {
        const { pending, user, sessions_revoked } = await get_db_sequelize().transaction(async (t) => {
            let target_id = user_id;
            if (opts.reset_token !== undefined) {
                target_id = (await this._password_links.redeem(opts.reset_token, t)).user_id;
            }
            const row = await User.findByPk(target_id!, { attributes: [...LINK_USER_ATTRS], raw: true, transaction: t });
            if (!row || row.deleted_at || !row.username) throw new ApiError('not_found', 'This link is not valid.', 404);
            if (row.status === 'suspended' || row.suspended_at) throw ApiError.not_active('suspended');

            await User.update({ password_hash, status: 'active' }, { where: { id: row.id }, transaction: t });
            await this._password_links.retire_open(row.id, t);
            const revoked = await this._token_repo.revoke_sessions(row.id, { except_id: opts.except_session, transaction: t });
            // The notice goes through the user's live account org; without one there is nobody to send it through.
            const account = await Org.findOne({ where: { slug: row.username, deleted_at: null }, attributes: ['id'], raw: true, transaction: t });
            const raised = account
                ? OrgEventService.raise_after_commit(t, {
                    event: USER_PASSWORD_CHANGED,
                    org_id: String(account.id),
                    actor: { user_id: row.id },
                    data: { user: event_user(row), sessions_revoked: revoked },
                })
                : null;
            if (!account) log.warn('password_changed_no_account_org', { user_id: row.id });
            return { pending: raised, user: row, sessions_revoked: revoked };
        });
        await pending?.result;
        log.info('password_changed', { user_id: user.id, via_link: opts.reset_token !== undefined, sessions_revoked });
        return { user: { id: user.id, username: user.username!, status: 'active' as const }, sessions_revoked };
    }
}
