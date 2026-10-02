import crypto from 'node:crypto';
import { assert_email_free, assert_namespace_free, on_name_race } from '../lib/namespace.js';
import { assert_password_rules, normalize_email, normalize_username } from '../lib/account_fields.js';
import { ApiError } from '../errors/api_error.js';
import { hash_password, verify_password } from '../auth/password.js';
import {
    default_grant_for_subject,
    type Grant_subject,
} from '../auth/grants.js';
import type { UserRepository } from '../repositories/user_repository.js';
import type { ScopeRepository } from '../repositories/scope_repository.js';
import type { OrgMemberRepository } from '../repositories/org_member_repository.js';
import type { OrgRepository } from '../repositories/org_repository.js';
import type { TokenRepository } from '../repositories/token_repository.js';
import type { AuthContext } from '../schemas/auth_types.js';
import type { EnvConfig } from '../config/env.js';
import { RealmService } from '../services/realm.service.js';
import { ensure_per_user_channel } from '../services/per_user_channel.service.js';
import { ensure_account_org } from './account_org.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('svc.auth');

function sha256_hex(plaintext: string): string {
    return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export class AuthService {
    constructor(
        private _user_repo: UserRepository,
        private _scope_repo: ScopeRepository,
        private _org_member_repo: OrgMemberRepository,
        private _config: EnvConfig,
        private _org_repo: OrgRepository,
        private _token_repo: TokenRepository,
    ) {
        void this._config; // retained for container wiring / future session TTL knobs
    }

    /**
     * Mint a session-scoped user PAT (`cliq_tok_…`) for BFF/CLI login.
     *
     * Who may call: internal auth flows only (`authenticate_user`,
     * `issue_session_token`, `signup`) — never a public Hub route.
     * Name is `session:…`; permissions = explicit `default_grant_for_subject`
     * (no empty-grant full-power). BFF revokes on logout / exit-act-as.
     *
     * @throws ApiError 403 `account_deleted` for a deleted user; 404 unknown user; 403 suspended
     */
    async mint_session_pat(user_id: string): Promise<{
        token: string;
        scopes: string[];
        org_ids: string[];
        org_slugs: string[];
    }> {
        log.debug('mint_session_pat', { user_id });
        const state = await this._user_repo.find_login_row_by_id(user_id);
        if (state?.deleted_at) throw ApiError.account_deleted();
        const user = await this._user_repo.find_profile_by_id(user_id);
        if (!user) throw new ApiError('not_found', 'User not found', 404);
        if (user.suspended_at) {
            throw new ApiError('forbidden', 'Account is suspended', 403);
        }

        const memberships = await this._org_member_repo.find_orgs_by_user(user.id);
        const org_ids = memberships.map((m) => m.org_id);
        const org_slugs = memberships.map((m) => m.slug);

        const [owned, org_scopes, member_scopes] = await Promise.all([
            this._scope_repo.find_owned_by_user(user.id),
            org_ids.length > 0 ? this._scope_repo.find_by_org_ids(org_ids) : Promise.resolve([]),
            this._scope_repo.find_member_scopes(user.id),
        ]);
        const scope_slugs = Array.from(
            new Set([...owned, ...org_scopes, ...member_scopes].map((s) => s.slug)),
        );

        let realm_ids: string[] = [];
        try {
            const { realms } = await RealmService.list_for_user(String(user.id));
            realm_ids = realms.map((r) => r.id);
        } catch (err) {
            log.warn('realm_list_failed', { error: err instanceof Error ? err.message : String(err) });
            realm_ids = [];
        }

        const subject: Grant_subject = {
            role: user.role,
            org_ids,
            scope_slugs,
            realm_ids,
        };
        const permissions = default_grant_for_subject(subject);

        const raw_token = `cliq_tok_${crypto.randomBytes(24).toString('hex')}`;
        const token_hash = await hash_password(raw_token);
        const prefix = sha256_hex(raw_token).slice(0, 16);
        const token_name = `session:${new Date().toISOString()}`;

        await this._token_repo.create({
            type: 'user',
            user_id: user.id,
            token_hash,
            token_prefix: prefix,
            name: token_name,
            permissions,
            scopes: [],
        });

        return {
            token: raw_token,
            scopes: scope_slugs,
            org_ids,
            org_slugs,
        };
    }

    /**
     * The username (also the account org's slug and its scope) and the email
     * must be free (lib/namespace.ts).
     *
     * @throws ApiError 409 conflict or 409 deleted
     */
    private async _assert_signup_names_free(username: string, email: string): Promise<void> {
        await assert_namespace_free(
            { org_repo: this._org_repo, scope_repo: this._scope_repo, user_repo: this._user_repo },
            username, ['user', 'org', 'scope'], 'username',
        );
        await assert_email_free(this._user_repo, email);
    }

    async signup(username: string, email: string, password: string) {
        log.debug('signup', { username });
        assert_password_rules(password);
        const norm_email = normalize_email(email);
        const norm_username = normalize_username(username);

        await this._assert_signup_names_free(norm_username, norm_email);

        const pw_hash = await hash_password(password);

        const { User: UserModel, Org, ScopeMember } = await import('../models/index.js');
        const { user, org_id } = await on_name_race(() => UserModel.sequelize!.transaction(async (t) => {
            const user_id = await this._user_repo.create(
                norm_username, norm_email, pw_hash, norm_username, t,
            );

            // The account org: default roles, owner membership, channels and rules.
            const org = await ensure_account_org(user_id, norm_username, t);

            const scope_id = await this._scope_repo.create(
                norm_username,
                norm_username,
                user_id,
                'public',
                'org',
                t,
                org.id,
            );
            await ScopeMember.create(
                { scope_id, user_id },
                { transaction: t },
            );
            await Org.update(
                { default_scope_id: scope_id },
                { where: { id: org.id }, transaction: t },
            );

            const created_user = await this._user_repo.find_by_id_with_transaction(user_id, t);
            if (!created_user) throw new ApiError('internal_error', 'Failed to read created user', 500);
            return { user: created_user, org_id: org.id };
        }), () => this._assert_signup_names_free(norm_username, norm_email));

        log.info('user_created', { user_id: user.id, username: norm_username });
        const minted = await this.mint_session_pat(user.id);

        const personal_realm = await RealmService.ensure_account_default_realm(
            String(user.id),
            norm_username,
        );

        /** Create per-user in-app notification channel for the new org (best-effort). */
        try {
            await ensure_per_user_channel(user.id, org_id, norm_username);
        } catch (err) {
            log.warn('per_user_channel_failed', { error: err instanceof Error ? err.message : String(err) });
            /* Non-fatal — channel will be created on next login or backfill. */
        }

        const default_realm_qualified = personal_realm.default_realm_slug
            ? `${norm_username}.${personal_realm.default_realm_slug}`
            : null;

        return {
            user,
            token: minted.token,
            account_id: org_id,
            account_slug: norm_username,
            default_realm_id: personal_realm.default_realm_id,
            default_realm_slug: personal_realm.default_realm_slug,
            default_realm_qualified,
            enroll_token: personal_realm.enroll_token,
        };
    }

    /**
     * Internal authenticate — password check + mint session PAT.
     * Called only from `/internal/auth/authenticate_user` (BFF).
     *
     * The password is checked first, so the answer tells nothing about an
     * account to someone without its password: an unknown user, a wrong
     * password and an account with no password yet (an invited person) all
     * get `401`. Only the right password on a deleted account gets `403
     * account_deleted`; on a suspended one, `403` suspended.
     *
     * @throws ApiError 401 invalid credentials; 403 `account_deleted`; 403 suspended
     */
    async authenticate_user(username: string, password: string) {
        log.debug('authenticate_user', { username });
        const row = await this._user_repo.find_by_username(username);
        const valid = Boolean(row?.password_hash) && await verify_password(password, row!.password_hash!);
        if (!row || !valid) throw new ApiError('unauthorized', 'Invalid credentials', 401);
        if (row.deleted_at) throw ApiError.account_deleted();

        if (row.suspended_at) throw new ApiError('forbidden', 'Account is suspended', 403);

        const user = await this._user_repo.find_profile_by_id(row.id);
        if (!user) throw new ApiError('unauthorized', 'Invalid credentials', 401);

        const minted = await this.mint_session_pat(user.id);
        const defaults = await AuthService._default_realm_fields(user.id);

        return {
            user,
            token: minted.token,
            scopes: minted.scopes,
            org_slugs: minted.org_slugs,
            ...defaults,
        };
    }

    /**
     * Site-admin only: mint a session PAT as `target_user_id` (act-as).
     * Caller must be authenticated as site admin (`auth.user.role === 'admin'`).
     * Rejects suspended / deleted / invited / missing / self. Does not revoke the admin's own PAT.
     *
     * @throws ApiError 403 not a site admin, `account_deleted` or suspended target;
     *   409 `not_active` for an invited target; 404 unknown target; 422 self
     */
    async issue_session_token(auth: AuthContext, target_user_id: string) {
        log.debug('issue_session_token', { user_id: auth.user?.id, target_user_id });
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        if (auth.user.role !== 'admin') {
            throw new ApiError('forbidden', 'Site admin required', 403);
        }
        if (target_user_id === auth.user.id) {
            throw new ApiError('invalid_params', 'Cannot issue a session token for yourself', 422);
        }

        const state = await this._user_repo.find_login_row_by_id(target_user_id);
        if (state) AuthService._assert_can_act_as(state);
        const target = await this._user_repo.find_profile_by_id(target_user_id);
        if (!target) throw new ApiError('not_found', 'User not found', 404);
        if (target.suspended_at) {
            throw new ApiError('forbidden', 'Target account is suspended', 403);
        }

        const minted = await this.mint_session_pat(target.id);
        const defaults = await AuthService._default_realm_fields(target.id);
        return {
            user_id: target.id,
            token: minted.token,
            default_realm_id: defaults.default_realm_id,
            default_realm_slug: defaults.default_realm_slug,
            default_realm_qualified: defaults.default_realm_qualified,
            orgs: defaults.orgs,
        };
    }

    /**
     * Soft-revoke a session PAT by plaintext. Idempotent — unknown or
     * already-revoked tokens still return `{ ok: true }`. Used by BFF logout.
     */
    async revoke_session_token(plaintext: string): Promise<{ ok: true }> {
        log.debug('revoke_session_token', {});
        if (!plaintext.startsWith('cliq_tok_')) {
            return { ok: true };
        }

        const prefix = sha256_hex(plaintext).slice(0, 16);
        const row = await this._token_repo.find_by_prefix(prefix);
        if (!row) return { ok: true };

        const valid = await verify_password(plaintext, row.token_hash);
        if (!valid) return { ok: true };

        await this._token_repo.soft_revoke_by_id(String(row.id));
        return { ok: true };
    }

    /**
     * Refuses an act-as session (site admin only) for a deleted user (`403
     * account_deleted`) or an invited one who has not set a password yet
     * (`409 not_active`). Sign-in itself never answers with these before the
     * password is checked.
     */
    private static _assert_can_act_as(row: { status: string; deleted_at: string | null }): void {
        if (row.deleted_at) throw ApiError.account_deleted();
        if (row.status === 'invited') throw ApiError.not_active('invited', 'Use the link in your invite email to set up your account first');
    }

    /**
     * Read-only: login reports the realm and orgs stored in the database and
     * never creates or repairs rows. A user without `default_realm_id` (or whose
     * realm was deleted) gets nulls. Orgs are the live orgs of the user's live,
     * active memberships (an open invite is not one).
     */
    private static async _default_realm_fields(
        user_id: string,
    ): Promise<{
        default_realm_id: string | null;
        default_realm_slug: string | null;
        /** Qualified slug in org.realm format (e.g., "cliq.default"). */
        default_realm_qualified: string | null;
        /** Always null: plaintext enroll tokens are only returned when minted. */
        enroll_token: null;
        /** All orgs the user belongs to, with their default realm info. */
        orgs: { id: string; slug: string; name: string; default_realm_slug: string | null }[];
    }> {
        const { User, OrgMember, Org, Realm } = await import('../models/index.js');
        const { Op } = await import('sequelize');

        const user_row = await User.findByPk(user_id, { attributes: ['id', 'default_realm_id'] });
        const realm_row = user_row?.default_realm_id
            ? await Realm.findOne({
                where: { id: user_row.default_realm_id, deleted: false },
                attributes: ['id', 'slug', 'org_id'],
            })
            : null;
        const realm_org = realm_row?.org_id
            ? await Org.findByPk(realm_row.org_id, { attributes: ['id', 'slug'] })
            : null;

        const memberships = await OrgMember.findAll({ where: { user_id, status: 'active', deleted_at: null }, attributes: ['org_id'] });
        const org_ids = memberships.map((m: { org_id: string }) => m.org_id);
        const org_rows = org_ids.length > 0
            ? await Org.findAll({
                where: { id: { [Op.in]: org_ids }, deleted_at: null },
                attributes: ['id', 'slug', 'display_name'],
            })
            : [];
        const org_default_realms = org_ids.length > 0
            ? await Realm.findAll({
                where: { org_id: { [Op.in]: org_ids }, slug: 'default', deleted: false },
                attributes: ['org_id', 'slug'],
            })
            : [];
        const default_slug_by_org = new Map(
            org_default_realms.map((r: { org_id: string | null; slug: string }) => [String(r.org_id), r.slug]),
        );

        return {
            default_realm_id: realm_row ? String(realm_row.id) : null,
            default_realm_slug: realm_row?.slug ?? null,
            default_realm_qualified: realm_row && realm_org ? `${realm_org.slug}.${realm_row.slug}` : null,
            enroll_token: null,
            orgs: org_rows.map((org_row: { id: string; slug: string; display_name: string | null }) => ({
                id: org_row.id,
                slug: org_row.slug,
                name: org_row.display_name ?? org_row.slug,
                default_realm_slug: default_slug_by_org.get(String(org_row.id)) ?? null,
            })),
        };
    }
}
