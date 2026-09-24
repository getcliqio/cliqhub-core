import crypto from 'node:crypto';
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
import type { AuthContext } from '../types/vo.js';
import {
    RESERVED_SCOPES, SLUG_PATTERN, EMAIL_PATTERN,
    MIN_PASSWORD_LENGTH, type EnvConfig,
} from '../config/env.js';
import { RealmService } from '../services/realm.service.js';
import { seed_default_roles_for_org } from '../db/migrate_org_roles.js';
import { ensure_per_user_channel } from '../services/per_user_channel.service.js';

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
     */
    async mint_session_pat(user_id: string): Promise<{
        token: string;
        scopes: string[];
        org_ids: string[];
        org_slugs: string[];
    }> {
        const user = await this._user_repo.find_by_id(user_id);
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
        } catch {
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

    async signup(username: string, email: string, password: string) {
        if (password.length < MIN_PASSWORD_LENGTH) {
            throw new ApiError('invalid_params', 'Password must be at least 8 characters', 422);
        }

        if (!EMAIL_PATTERN.test(email)) {
            throw new ApiError('invalid_params', 'Invalid email format', 422);
        }

        const norm_username = username.trim().toLowerCase();
        const norm_email = email.trim().toLowerCase();

        if (RESERVED_SCOPES.includes(norm_username)) {
            throw new ApiError('invalid_params', 'That username is reserved', 422);
        }

        if (!SLUG_PATTERN.test(norm_username)) {
            throw new ApiError('invalid_params', 'Username must start with a letter and contain only lowercase letters, numbers, and hyphens', 422);
        }

        const existing = await this._user_repo.find_by_username_or_email(norm_username, norm_email);
        if (existing) {
            throw new ApiError('conflict', 'Username or email already taken', 409);
        }

        const existing_org = await this._org_repo.find_by_slug(norm_username);
        if (existing_org) {
            throw new ApiError('conflict', 'An account with that name already exists', 409);
        }

        const existing_scope = await this._scope_repo.find_by_slug(norm_username);
        if (existing_scope) {
            throw new ApiError('conflict', 'A scope with that name already exists', 409);
        }

        const pw_hash = await hash_password(password);

        const { User: UserModel, Org, OrgMember, OrgRole, ScopeMember } = await import('../db/models/index.js');
        const { user, org_id } = await UserModel.sequelize!.transaction(async (t) => {
            const user_id = await this._user_repo.create(
                norm_username, norm_email, pw_hash, norm_username, t,
            );

            const org = await Org.create(
                { slug: norm_username, display_name: norm_username },
                { transaction: t },
            );

            // Seed default roles for the new personal org.
            // Must run inside the same transaction — the outer connection
            // cannot see the just-created `orgs` row until commit, so
            // uncoupled inserts fail with `org_roles_org_id_fkey`.
            await seed_default_roles_for_org(org.id, t);

            // Assign the owner role to the org creator.
            const owner_role = await OrgRole.findOne({
                where: { org_id: org.id, slug: 'owner' },
            });

            await OrgMember.create(
                { org_id: org.id, user_id, role: 'admin', role_id: owner_role?.id ?? null },
                { transaction: t },
            );

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
        });

        const minted = await this.mint_session_pat(user.id);

        const personal_realm = await RealmService.ensure_account_default_realm(
            String(user.id),
            norm_username,
        );

        /** Create per-user in-app notification channel for the new org (best-effort). */
        try {
            await ensure_per_user_channel(user.id, org_id, norm_username);
        } catch {
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
     */
    async authenticate_user(username: string, password: string) {
        const row = await this._user_repo.find_by_username(username);
        if (!row) throw new ApiError('unauthorized', 'Invalid credentials', 401);

        const valid = await verify_password(password, row.password_hash);
        if (!valid) throw new ApiError('unauthorized', 'Invalid credentials', 401);

        if (row.suspended_at) throw new ApiError('forbidden', 'Account is suspended', 403);

        const user = await this._user_repo.find_by_id(row.id);
        if (!user) throw new ApiError('unauthorized', 'Invalid credentials', 401);

        const minted = await this.mint_session_pat(user.id);
        const defaults = await AuthService._default_realm_fields(user.id, user.username);

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
     * Rejects suspended / missing / self. Does not revoke the admin's own PAT.
     */
    async issue_session_token(auth: AuthContext, target_user_id: string) {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        if (auth.user.role !== 'admin') {
            throw new ApiError('forbidden', 'Site admin required', 403);
        }
        if (target_user_id === auth.user.id) {
            throw new ApiError('invalid_params', 'Cannot issue a session token for yourself', 422);
        }

        const target = await this._user_repo.find_by_id(target_user_id);
        if (!target) throw new ApiError('not_found', 'User not found', 404);
        if (target.suspended_at) {
            throw new ApiError('forbidden', 'Target account is suspended', 403);
        }

        const minted = await this.mint_session_pat(target.id);
        const defaults = await AuthService._default_realm_fields(target.id, target.username);
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

    private static async _default_realm_fields(
        user_id: string,
        username: string,
    ): Promise<{
        default_realm_id: string | null;
        default_realm_slug: string | null;
        /** Qualified slug in org.realm format (e.g., "elan.default"). */
        default_realm_qualified: string | null;
        enroll_token: string | null;
        /** All orgs the user belongs to, with their default realm info. */
        orgs: { id: string; slug: string; name: string; default_realm_slug: string }[];
    }> {
        // Always run ensure — migrates legacy `*-default-realm` → `{account}.default` in place.
        const personal = await RealmService.ensure_personal_realm(String(user_id), username);

        // Build qualified slug: personal org slug + realm slug.
        const default_realm_qualified = personal.default_realm_slug
            ? `${username.trim().toLowerCase()}.${personal.default_realm_slug}`
            : null;

        // Build orgs list with default realm info.
        let orgs: { id: string; slug: string; name: string; default_realm_slug: string }[] = [];
        try {
            const { OrgMember, Org } = await import('../db/models/index.js');
            const { Realm } = await import('../models/index.js');
            const memberships = await OrgMember.findAll({
                where: { user_id },
                attributes: ['org_id'],
            });
            const org_ids = memberships.map((m: { org_id: string }) => m.org_id);
            if (org_ids.length > 0) {
                const { Op } = await import('sequelize');
                const org_rows = await Org.findAll({
                    where: { id: { [Op.in]: org_ids } },
                    attributes: ['id', 'slug', 'name'],
                });
                for (const org_row of org_rows) {
                    // Find the org's default realm (slug = 'default' within this org).
                    const default_realm = await Realm.findOne({
                        where: { org_id: org_row.id, slug: 'default', deleted: false },
                        attributes: ['slug'],
                    });
                    orgs.push({
                        id: org_row.id,
                        slug: org_row.slug,
                        name: org_row.display_name ?? org_row.slug,
                        default_realm_slug: default_realm?.slug ?? 'default',
                    });
                }
            }
        } catch { /* best-effort */ }

        return {
            default_realm_id: personal.default_realm_id,
            default_realm_slug: personal.default_realm_slug,
            default_realm_qualified,
            enroll_token: personal.enroll_token,
            orgs,
        };
    }
}
