import crypto from 'node:crypto';
import { ApiError } from '../errors/api_error.js';
import { ApiError as CoreApiError } from '../lib/api_error.js';
import { RESERVED_SCOPES, SLUG_PATTERN, EMAIL_PATTERN, MIN_PASSWORD_LENGTH, type EnvConfig } from '../config/env.js';
import type { OrgRepository } from '../repositories/org_repository.js';
import type { OrgMemberRepository } from '../repositories/org_member_repository.js';
import type { ScopeRepository } from '../repositories/scope_repository.js';
import type { UserRepository } from '../repositories/user_repository.js';
import type { AuthContext } from '../schemas/auth_types.js';
import { AccountInviteRepository } from '../repositories/account_invite_repository.js';
import { RealmInviteRepository } from '../repositories/realm_invite_repository.js';
import { RealmRepository } from '../repositories/realm_repository.js';
import { OrgRepository as _OrgRepositoryClass } from '../repositories/org_repository.js';
import { hash_password } from '../auth/password.js';
import { RealmService } from '../services/realm.service.js';
import { Op } from 'sequelize';
import { get_logger } from '../lib/log.js';

const log = get_logger('svc.invitations');

const _account_invite_repo = new AccountInviteRepository();
const _realm_invite_repo_inv = new RealmInviteRepository();
const _org_repo_inv = new _OrgRepositoryClass();
const _realm_repo_inv = new RealmRepository();

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function hash_invite_token(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function escape_like(input: string): string {
    return input.replace(/[%_\\]/g, '\\$&');
}

function map_invite_row(row: {
    id: string;
    email: string;
    role: string;
    invited_by: string;
    created_at: Date | string;
    expires_at: Date | string;
    status?: string;
}) {
    return {
        id: row.id,
        email: row.email,
        role: row.role,
        invited_by: row.invited_by,
        status: row.status ?? 'pending',
        created_at: row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at),
        expires_at: row.expires_at instanceof Date
            ? row.expires_at.toISOString()
            : String(row.expires_at),
    };
}

export class InvitationsService {
    constructor(
        private _org_repo: OrgRepository,
        private _org_member_repo: OrgMemberRepository,
        private _scope_repo: ScopeRepository,
        private _user_repo: UserRepository,
        private _config?: EnvConfig,
        /** Mints the new user's session PAT (`AuthService.mint_session_pat`). */
        private _mint_session_pat?: (user_id: string) => Promise<{ token: string }>,
    ) {}

    private _require_auth(auth: AuthContext) {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
    }

    /** Org invites with target_type 'org': the route policy may have judged realm_id, so the org is checked here. */
    private async _require_org_admin(auth: AuthContext, org_id: string): Promise<void> {
        this._require_auth(auth);
        if (auth.user!.role === 'admin') return;

        const { require_permission } = await import('../auth/permissions.js');
        await require_permission(org_id, auth.user!.id, 'org.members.manage', {
            site_role: auth.user!.role,
        });
    }

    private _is_not_found(err: unknown): boolean {
        if (err instanceof ApiError && err.code === 'not_found') return true;
        if (err instanceof CoreApiError && err.status_code === 404) return true;
        return false;
    }

    // ─── Manage (/v1): create / get / get_by_id / revoke ─────────────

    async create(auth: AuthContext, params: {
        target_type: 'org' | 'realm';
        org_id?: string;
        realm_id?: string;
        email: string;
        role?: 'admin' | 'member' | 'operator';
    }) {
        log.debug('create', { user_id: auth.user?.id, target_type: params.target_type, org_id: params.org_id, realm_id: params.realm_id });
        this._require_auth(auth);

        if (params.target_type === 'org') {
            const result = await this._create_org_invite(auth, {
                org_id: params.org_id!,
                email: params.email,
                role: params.role === 'admin' || params.role === 'member' ? params.role : 'member',
            });
            return { target_type: 'org' as const, ...result };
        }

        // Realm invite: route policy checked realm admin + realms.members.manage.
        const result = await RealmService.create_invite(
            params.realm_id!,
            String(auth.user!.id),
            {
                email: params.email,
                role: params.role as 'admin' | 'operator' | 'member' | undefined,
            },
        );
        return { target_type: 'realm' as const, ...result };
    }

    async get(auth: AuthContext, params: {
        target_type: 'org' | 'realm';
        org_id?: string;
        realm_id?: string;
        query?: string;
        limit?: number;
        offset?: number;
    }) {
        log.debug('get', { user_id: auth.user?.id, target_type: params.target_type, org_id: params.org_id, realm_id: params.realm_id });
        this._require_auth(auth);

        if (params.target_type === 'org') {
            const result = await this._list_org_invites(auth, {
                org_id: params.org_id!,
                query: params.query,
                limit: params.limit,
                offset: params.offset,
            });
            return { target_type: 'org' as const, org_id: params.org_id!, ...result };
        }

        const result = await this._list_realm_invites(auth, {
            realm_id: params.realm_id!,
            query: params.query,
            limit: params.limit,
            offset: params.offset,
        });
        return { target_type: 'realm' as const, realm_id: params.realm_id!, ...result };
    }

    async get_by_id(auth: AuthContext, params: {
        target_type: 'org' | 'realm';
        invite_id: string;
    }) {
        log.debug('get_by_id', { invite_id: params.invite_id, user_id: auth.user?.id });
        this._require_auth(auth);

        if (params.target_type === 'org') {
            const invite = await _account_invite_repo.find_by_id(params.invite_id);
            if (!invite) throw new ApiError('not_found', 'Invite not found', 404);
            // Route policy loaded the invite: org.members.manage.
            return {
                target_type: 'org' as const,
                org_id: invite.org_id,
                invite: map_invite_row(invite),
            };
        }

        const invite = await _realm_invite_repo_inv.find_by_id(params.invite_id);
        if (!invite) throw new ApiError('not_found', 'Invite not found', 404);
        // Route policy loaded the invite: realm admin + realms.members.manage.
        return {
            target_type: 'realm' as const,
            realm_id: invite.realm_id,
            invite: map_invite_row(invite),
        };
    }

    async revoke(auth: AuthContext, params: {
        target_type: 'org' | 'realm';
        invite_id: string;
    }) {
        log.debug('revoke', { invite_id: params.invite_id, user_id: auth.user?.id });
        this._require_auth(auth);

        if (params.target_type === 'org') {
            return this._revoke_org_invite(auth, { invite_id: params.invite_id });
        }

        await RealmService.revoke_invite(params.invite_id, String(auth.user!.id));
        return { revoked: true };
    }

    // ─── Public: get_by_token / accept (org first, then realm) ───────

    async get_by_token(_auth: AuthContext, params: { token: string }) {
        log.debug('get_by_token', {});
        try {
            const org_invite = await this._get_org_invite_by_token(params.token);
            return { target_type: 'org' as const, ...org_invite };
        } catch (err) {
            if (!this._is_not_found(err)) throw err;
        }

        try {
            const realm_invite = await RealmService.get_invite_by_token(params.token);
            return { target_type: 'realm' as const, ...realm_invite };
        } catch (err) {
            if (this._is_not_found(err)) {
                throw new ApiError('not_found', 'Invite not found', 404);
            }
            throw err;
        }
    }

    async accept(auth: AuthContext, params: {
        token: string;
        username?: string;
        password?: string;
        display_name?: string;
    }) {
        log.debug('accept', { user_id: auth.user?.id });
        try {
            const org_result = await this._accept_org_invite(auth, params);
            return { target_type: 'org' as const, ...org_result };
        } catch (err) {
            if (!this._is_not_found(err)) throw err;
        }

        try {
            const realm_result = await this._accept_realm_invite(auth, params);
            return { target_type: 'realm' as const, ...realm_result };
        } catch (err) {
            if (this._is_not_found(err)) {
                throw new ApiError('not_found', 'Invite not found', 404);
            }
            throw err;
        }
    }

    // ─── Realm invite accept (#15) ───────────────────────────────────
    //
    // A pending realm invite only exists for an email with no account (existing
    // users are added to the realm directly), so accepting it must be able to
    // create the account — same fields and checks as an org invite. The invitee
    // gets the invited realm role and joins the realm's org as a Member.

    private async _accept_realm_invite(auth: AuthContext, params: {
        token: string;
        username?: string;
        password?: string;
        display_name?: string;
    }) {
        // Peek first: garbage / expired tokens fail before any account is created.
        const preview = await RealmService.get_invite_by_token(params.token);

        let user_id: string;
        let username: string;
        let created = false;
        if (auth.user) {
            user_id = String(auth.user.id);
            username = auth.user.username;
        } else {
            ({ user_id, username } = await this._create_invited_user(preview.email, params));
            created = true;
        }

        // Email match is checked here for signed-in callers.
        const accepted = await RealmService.accept_invite(params.token, user_id, auth.user ? (auth.user.email ?? '') : preview.email);

        const realm = await _realm_repo_inv.find_by_id(accepted.realm_id);
        const org_id = realm?.org_id ? String(realm.org_id) : null;
        if (org_id && !(await this._org_member_repo.find_by_org_and_user(org_id, user_id))) {
            await this._org_member_repo.create(org_id, user_id, 'member');
            log.info('realm_invite_org_member_added', { org_id, realm_id: accepted.realm_id, user_id });
        }

        const result: typeof accepted & { org_id: string | null; username: string; token?: string } = {
            ...accepted,
            org_id,
            username,
        };
        if (created) {
            await RealmService.ensure_personal_realm(user_id, username);
            if (!this._mint_session_pat) {
                throw new ApiError('internal_error', 'Session token minting unavailable', 500);
            }
            result.token = (await this._mint_session_pat(user_id)).token;
            log.info('realm_invite_account_created', { realm_id: accepted.realm_id, user_id });
        }
        log.info('realm_invite_accepted', { realm_id: accepted.realm_id, user_id, role: accepted.role, created });
        return result;
    }

    /**
     * Create the account an invitation was sent to. The email comes from the
     * invite; an existing account must sign in instead.
     */
    private async _create_invited_user(email: string, params: {
        username?: string;
        password?: string;
        display_name?: string;
    }): Promise<{ user_id: string; username: string }> {
        const existing = await this._user_repo.find_by_email(email);
        if (existing) {
            throw new ApiError(
                'unauthorized',
                'An account with this email already exists — sign in to accept the invite',
                401,
            );
        }

        const username = (params.username ?? '').trim().toLowerCase();
        const password = params.password ?? '';
        if (!username) throw new ApiError('invalid_params', 'username is required', 422);
        if (password.length < MIN_PASSWORD_LENGTH) {
            throw new ApiError('invalid_params', 'Password must be at least 8 characters', 422);
        }
        if (!SLUG_PATTERN.test(username)) {
            throw new ApiError('invalid_params', 'Username must start with a letter and contain only lowercase letters, numbers, and hyphens', 422);
        }
        if (RESERVED_SCOPES.includes(username)) {
            throw new ApiError('invalid_params', `Username '${username}' is reserved`, 422);
        }

        const taken = await this._user_repo.find_by_username_or_email(username, email);
        if (taken) throw new ApiError('conflict', 'Username or email already taken', 409);

        const pw_hash = await hash_password(password);
        const display = params.display_name?.trim() || username;
        const user_id = await this._user_repo.create(username, email, pw_hash, display);

        const existing_user_scope = await this._scope_repo.find_by_slug(username);
        if (!existing_user_scope) {
            await this._scope_repo.create(username, display, user_id, 'public', 'user');
        }
        return { user_id: String(user_id), username };
    }

    // ─── Org invite helpers (moved from OrgsService) ─────────────────

    private async _create_org_invite(auth: AuthContext, params: {
        org_id: string;
        email: string;
        role?: 'admin' | 'member';
    }) {
        await this._require_org_admin(auth, params.org_id);

        const email = params.email.trim().toLowerCase();
        if (!EMAIL_PATTERN.test(email)) {
            throw new ApiError('invalid_params', 'Invalid email address', 422);
        }

        const role = params.role ?? 'member';
        const existing_user_row = await this._user_repo.find_by_email(email);
        if (existing_user_row) {
            const existing_user = await this._user_repo.find_profile_by_id(existing_user_row.id);
            if (!existing_user) throw new ApiError('not_found', 'User not found', 404);

            const membership = await this._org_member_repo.find_by_org_and_user(params.org_id, existing_user.id);
            if (membership) throw new ApiError('conflict', 'User is already a member', 409);

            await this._org_member_repo.create(params.org_id, existing_user.id, role);
            return {
                status: 'added' as const,
                user_id: existing_user.id,
                username: existing_user.username,
                role,
            };
        }

        const pending = await _account_invite_repo.find_one_q({ where: { org_id: params.org_id, email, status: 'pending' }, attributes: ['id'], raw: true });
        if (pending) throw new ApiError('conflict', 'A pending invite already exists for that email', 409);

        const token = crypto.randomBytes(32).toString('hex');
        const expires_at = new Date(Date.now() + INVITE_TTL_MS);
        const invite = await _account_invite_repo.create_one({
            org_id: params.org_id,
            email,
            invited_by: auth.user!.id,
            token_hash: hash_invite_token(token),
            role,
            status: 'pending',
            expires_at,
        });

        return {
            status: 'pending' as const,
            invite_id: invite.id,
            email,
            role,
            expires_at: expires_at.toISOString(),
            token,
        };
    }

    private async _list_org_invites(auth: AuthContext, params: {
        org_id: string;
        query?: string;
        limit?: number;
        offset?: number;
    }) {
        // Policy may have judged realm_id instead: check the org here (same rule as the policy's org branch).
        await this._require_org_admin(auth, params.org_id);

        const where: Record<string, unknown> = {
            org_id: params.org_id,
            status: 'pending',
        };
        const q = params.query?.trim();
        if (q) {
            where.email = { [Op.iLike]: `%${escape_like(q)}%` };
        }

        const invites = await _account_invite_repo.find_all_q({
            where,
            attributes: ['id', 'email', 'role', 'created_at', 'expires_at', 'invited_by', 'status'],
            order: [['created_at', 'DESC']],
            limit: Math.min(params.limit ?? 50, 100),
            offset: params.offset ?? 0,
            raw: true,
        });

        return { invites: invites.map(map_invite_row) };
    }

    private async _list_realm_invites(auth: AuthContext, params: {
        realm_id: string;
        query?: string;
        limit?: number;
        offset?: number;
    }) {
        // Route policy: realm admin + realms.members.manage.

        const where: Record<string, unknown> = {
            realm_id: params.realm_id,
            status: 'pending',
        };
        const q = params.query?.trim();
        if (q) {
            where.email = { [Op.iLike]: `%${escape_like(q)}%` };
        }

        const invites = await _realm_invite_repo_inv.find_all_q({
            where,
            attributes: ['id', 'email', 'role', 'created_at', 'expires_at', 'invited_by', 'status'],
            order: [['created_at', 'DESC']],
            limit: Math.min(params.limit ?? 50, 100),
            offset: params.offset ?? 0,
            raw: true,
        });

        return { invites: invites.map(map_invite_row) };
    }

    private async _revoke_org_invite(auth: AuthContext, params: { invite_id: string }) {
        const invite = await _account_invite_repo.find_by_id(params.invite_id);
        if (!invite) throw new ApiError('not_found', 'Invite not found', 404);
        // Route policy loaded the invite: org.members.manage.
        if (invite.status !== 'pending') {
            throw new ApiError('conflict', 'Invite is not pending', 409);
        }

        await _account_invite_repo.update_where({ id: invite.id } as any, { status: 'revoked' } as any);
        return { revoked: true };
    }

    private async _get_org_invite_by_token(token: string) {
        const invite = await this._load_pending_org_invite(token);
        const org = await this._org_repo.find_by_id(invite.org_id);
        if (!org) throw new ApiError('not_found', 'Account not found', 404);

        return {
            email: invite.email,
            role: invite.role,
            org_id: org.id,
            org_slug: org.slug,
            org_display_name: org.display_name,
            expires_at: invite.expires_at instanceof Date
                ? invite.expires_at.toISOString()
                : String(invite.expires_at),
        };
    }

    private async _accept_org_invite(auth: AuthContext, params: {
        token: string;
        username?: string;
        password?: string;
        display_name?: string;
    }) {
        const invite = await this._load_pending_org_invite(params.token);

        if (auth.user) {
            if (auth.user.email.trim().toLowerCase() !== invite.email) {
                throw new ApiError('forbidden', 'Signed-in email does not match this invite', 403);
            }
            return this._accept_org_for_user(invite, auth.user.id, auth.user.username, false);
        }

        const { user_id, username } = await this._create_invited_user(invite.email, params);
        return this._accept_org_for_user(invite, user_id, username, true);
    }

    private async _load_pending_org_invite(token: string) {
        const trimmed = token.trim();
        if (!trimmed) throw new ApiError('invalid_params', 'token is required', 422);

        const invite = await _account_invite_repo.find_one_q({ where: { token_hash: hash_invite_token(trimmed), status: 'pending' }, raw: true });
        if (!invite) throw new ApiError('not_found', 'Invite not found', 404);

        const expires_at = invite.expires_at instanceof Date
            ? invite.expires_at
            : new Date(invite.expires_at);
        if (expires_at.getTime() < Date.now()) {
            await _account_invite_repo.update_where({ id: invite.id } as any, { status: 'revoked' } as any);
            throw new ApiError('conflict', 'Invite has expired', 409);
        }

        return invite;
    }

    private async _accept_org_for_user(
        invite: {
            id: string;
            org_id: string;
            role: 'admin' | 'member';
            email: string;
        },
        user_id: string,
        username: string,
        issue_token: boolean,
    ) {
        const membership = await this._org_member_repo.find_by_org_and_user(invite.org_id, user_id);
        if (!membership) {
            await this._org_member_repo.create(invite.org_id, user_id, invite.role);
        }

        const org = await _org_repo_inv.find_by_id(invite.org_id);
        if (org?.slug) {
            await RealmService.ensure_org_default_realm(
                org.slug,
                String(user_id),
                String(user_id),
            );
        }

        // Invitee also needs a personal org + default realm — the inviting
        // org membership is not a substitute for a personal namespace.
        await RealmService.ensure_personal_realm(String(user_id), username);

        await _account_invite_repo.update_where(
            { id: invite.id } as any,
            {
                status: 'accepted',
                accepted_at: new Date(),
                accepted_user_id: user_id,
            } as any,
        );

        const result: {
            accepted: true;
            org_id: string;
            user_id: string;
            username: string;
            role: 'admin' | 'member';
            token?: string;
        } = {
            accepted: true,
            org_id: invite.org_id,
            user_id,
            username,
            role: invite.role,
        };

        if (issue_token) {
            // Session PAT (cliq_tok_…), the same credential sign-in returns. Core
            // no longer accepts JWTs, so the old signed token was unusable (B2).
            if (!this._mint_session_pat) {
                throw new ApiError('internal_error', 'Session token minting unavailable', 500);
            }
            result.token = (await this._mint_session_pat(user_id)).token;
        }

        return result;
    }
}
