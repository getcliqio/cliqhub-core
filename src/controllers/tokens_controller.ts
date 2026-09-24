import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { BaseController } from './base_controller.js';
import { ApiError } from '../errors/api_error.js';
import { hash_password, verify_password } from '../auth/password.js';
import type { TokenRepository } from '../repositories/token_repository.js';
import type { OrgMemberRepository } from '../repositories/org_member_repository.js';
import {
    generate_token_schema,
    get_tokens_schema,
    revoke_token_schema,
    rotate_token_schema,
    validate_token_schema,
} from '../schemas/tokens_schemas.js';
import {
    clamp_grant_to_subject,
    default_daemon_grant,
    default_grant_for_subject,
    normalize_grant,
    type Grant_subject,
    type Token_grant,
} from '../auth/grants.js';
import { RealmService } from '../services/realm.service.js';
import { RealmA2aService } from '../services/realm_a2a.service.js';
import { RealmDispatchKeyService } from '../services/realm_dispatch_key.service.js';
import { DispatchAuthService } from '../services/dispatch_auth.service.js';

function primary_realm_id(grant: Token_grant): string | undefined {
    const realms = grant.domains.realms;
    if (realms === '*') return undefined;
    if (!Array.isArray(realms) || realms.length === 0) return undefined;
    const first = realms.find((r): r is string => typeof r === 'string' && r !== '*');
    return first;
}

function sha256_hex(plaintext: string): string {
    return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export class TokensController extends BaseController {
    constructor(
        private _token_repo: TokenRepository,
        private _org_member_repo: OrgMemberRepository,
    ) {
        super();
    }

    private _require_auth(req: Request) {
        if (!req.auth?.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        return req.auth.user;
    }

    private async _subject_for(req: Request): Promise<Grant_subject> {
        const user = this._require_auth(req);
        const org_ids = req.auth.org_ids ?? [];
        const scope_slugs = (req.auth.scopes ?? []).map((s) => s.slug);
        let realm_ids: string[] = [];
        try {
            const { realms } = await RealmService.list_for_user(String(user.id));
            realm_ids = realms.map((r) => r.id);
        } catch {
            realm_ids = [];
        }
        return {
            role: user.role,
            org_ids,
            scope_slugs,
            realm_ids,
        };
    }

    private async _resolve_user_grant(req: Request, raw: unknown): Promise<Token_grant> {
        const subject = await this._subject_for(req);
        const fallback = default_grant_for_subject(subject);
        if (raw == null || (typeof raw === 'object' && Object.keys(raw as object).length === 0)) {
            return fallback;
        }
        const normalized = normalize_grant(raw, fallback);
        return clamp_grant_to_subject(normalized, subject);
    }

    private async _resolve_realm_ids(
        req: Request,
        body: {
            realm_ids?: string[];
            permissions?: { domains?: { realms?: Array<string | '*'> | '*' } };
        },
    ): Promise<string[]> {
        const from_body = body.realm_ids ?? [];
        const from_perms = body.permissions?.domains?.realms;
        const from_grant = Array.isArray(from_perms)
            ? from_perms.filter((r): r is string => typeof r === 'string' && r !== '*')
            : [];
        const realm_ids = [...new Set([...from_body, ...from_grant])];
        if (realm_ids.length === 0) {
            throw new ApiError('bad_request', 'At least one realm is required for realm tokens', 400);
        }

        const user = this._require_auth(req);
        for (const realm_id of realm_ids) {
            // Realm members may mint (daemon bootstrap); admins keep list/revoke.
            await RealmService.assert_member(realm_id, String(user.id));
        }
        return realm_ids;
    }

    generate_token = this.wrap(async (req: Request, res: Response) => {
        const user = this._require_auth(req);
        const body = this.parse_body(generate_token_schema, req);

        /**
         * A2A bearer lives on the realm row (hashed). Same mint path as rotate —
         * generate_token type=a2a replaces /v1/realms/a2a/rotate_bearer.
         */
        if (body.type === 'a2a') {
            const realm_id = body.realm_id!;
            const created = await RealmA2aService.rotate_bearer(realm_id, String(user.id));
            this.ok(res, {
                type: 'a2a',
                token: created.bearer,
                bearer: created.bearer,
                realm_id,
                has_bearer: created.has_bearer,
                bearer_prefix: created.bearer_prefix,
            }, 201);
            return;
        }

        if (body.type === 'daemon_wire') {
            const realm_id = await RealmDispatchKeyService.resolve_realm_id(
                String(user.id),
                body.realm_id!,
            );
            const minted = await DispatchAuthService.mint_token({
                realm_id,
                aud: body.aud,
                run_id: body.run_id,
                action: body.action,
            });
            this.ok(res, {
                type: 'daemon_wire',
                token: minted.token,
                expires_in: minted.expires_in,
                realm_id: minted.realm_id,
            }, 201);
            return;
        }

        if (body.type === 'realm') {
            const realm_ids = await this._resolve_realm_ids(req, body);
            const token_name = body.name?.trim() || 'Daemon token';
            const fallback = default_daemon_grant(realm_ids);
            const permissions = body.permissions
                ? normalize_grant(body.permissions, fallback)
                : fallback;
            permissions.domains.realms = realm_ids;
            const permissions_out: Record<string, unknown> = { ...permissions };
            if (body.permissions?.auto_enrolled === true) {
                permissions_out.auto_enrolled = true;
            }

            const created = await RealmService.create_token_for_realms(
                realm_ids,
                String(user.id),
                token_name,
                permissions_out,
            );

            this.ok(res, {
                token: created.token,
                id: created.id,
                name: created.name,
                realm_ids,
            }, 201);
            return;
        }

        const permissions = await this._resolve_user_grant(req, body.permissions ?? {});
        const raw_token = `cliq_tok_${crypto.randomBytes(24).toString('hex')}`;
        const token_hash = await hash_password(raw_token);
        const prefix = sha256_hex(raw_token).slice(0, 16);
        const token_name = body.name?.trim() || 'API token';

        const record = await this._token_repo.create({
            type: 'user',
            user_id: user.id,
            token_hash,
            token_prefix: prefix,
            name: token_name,
            permissions,
            scopes: [],
        });

        const realm_ids = Array.isArray(permissions.domains?.realms)
            ? permissions.domains.realms.filter((r): r is string => typeof r === 'string' && r !== '*')
            : [];

        this.ok(res, {
            token: raw_token,
            name: token_name,
            id: record.id,
            realm_ids,
        }, 201);
    });

    get_tokens = this.wrap(async (req: Request, res: Response) => {
        const user = this._require_auth(req);
        const body = this.parse_body(get_tokens_schema, req);
        const limit = body.limit ?? 50;
        const offset = body.offset ?? 0;

        const query = body.query?.trim() || undefined;

        if (body.realm_id) {
            const rows = await RealmService.list_tokens(body.realm_id, String(user.id));
            const active = rows.filter((t) => {
                if (t.revoked_at) return false;
                if (!query) return true;
                return t.name.toLowerCase().includes(query.toLowerCase());
            });
            const tokens = active.slice(offset, offset + limit).map((t) => {
                const grant = t.permissions as unknown as Token_grant;
                const realm_ids = Array.isArray(grant?.domains?.realms)
                    ? (grant.domains.realms as Array<string | '*'>).filter(
                        (r): r is string => typeof r === 'string' && r !== '*',
                    )
                    : (t.realm_id ? [t.realm_id] : []);
                return {
                    type: 'realm' as const,
                    id: t.id,
                    name: t.name,
                    realm_id: t.realm_id,
                    realm_ids,
                    permissions: t.permissions,
                    created_at: t.created_at,
                    revoked_at: t.revoked_at,
                };
            });
            this.ok(res, { tokens, total: active.length });
            return;
        }

        const type = body.type;
        const [rows, total] = await Promise.all([
            this._token_repo.list_by_user_id(user.id, { type, query, limit, offset }),
            this._token_repo.count_by_user_id(user.id, { type, query }),
        ]);
        const tokens = rows.map((t) => {
            const grant = t.permissions as Token_grant;
            const realm_ids = Array.isArray(grant?.domains?.realms)
                ? (grant.domains.realms as Array<string | '*'>).filter(
                    (r): r is string => typeof r === 'string' && r !== '*',
                )
                : [];
            return {
                type: t.type,
                id: t.id,
                name: t.name,
                realm_id: t.type === 'realm' ? primary_realm_id(grant) : undefined,
                realm_ids: t.type === 'realm' ? realm_ids : undefined,
                permissions: t.permissions,
                created_at: t.created_at,
                last_used_at: t.last_used_at ?? null,
                revoked_at: t.revoked_at,
            };
        });
        this.ok(res, { tokens, total });
    });

    revoke_token = this.wrap(async (req: Request, res: Response) => {
        const user = this._require_auth(req);
        const body = this.parse_body(revoke_token_schema, req);
        const token = await this._token_repo.find_by_id(body.token_id);
        if (!token || token.revoked_at) throw new ApiError('not_found', 'Token not found', 404);
        if (token.type !== body.type) throw new ApiError('not_found', 'Token not found', 404);
        if (token.user_id !== user.id) {
            const realm_admin_ok = body.type === 'realm' && Boolean(body.realm_id);
            if (!realm_admin_ok) {
                throw new ApiError('forbidden', 'Not your token', 403);
            }
            await RealmService.require_admin(body.realm_id!, String(user.id));
        }

        const count = await this._token_repo.soft_revoke(body.token_id);
        if (count === 0) throw new ApiError('not_found', 'Token not found', 404);
        this.ok(res, { revoked: true, type: body.type });
    });

    rotate_token = this.wrap(async (req: Request, res: Response) => {
        const user = this._require_auth(req);
        const body = this.parse_body(rotate_token_schema, req);

        if (body.type === 'a2a') {
            const realm_id = body.realm_id!;
            const created = await RealmA2aService.rotate_bearer(realm_id, String(user.id));
            this.ok(res, {
                type: 'a2a',
                token: created.bearer,
                bearer: created.bearer,
                realm_id,
                has_bearer: created.has_bearer,
                bearer_prefix: created.bearer_prefix,
            });
            return;
        }

        const token = await this._token_repo.find_by_id(body.token_id!);
        if (!token || token.revoked_at) throw new ApiError('not_found', 'Token not found', 404);
        if (token.user_id !== user.id) throw new ApiError('forbidden', 'Not your token', 403);
        if (token.type !== body.type) throw new ApiError('not_found', 'Token not found', 404);

        if (body.type === 'realm') {
            const raw_token = `cliq_dt_${crypto.randomBytes(32).toString('base64url')}`;
            const token_hash = sha256_hex(raw_token);
            await this._token_repo.update_hash(body.token_id!, token_hash, token_hash.slice(0, 16));
            this.ok(res, {
                type: 'realm',
                token: raw_token,
                permissions: token.permissions,
            });
            return;
        }

        const raw_token = `cliq_tok_${crypto.randomBytes(24).toString('hex')}`;
        const token_hash = await hash_password(raw_token);
        const prefix = sha256_hex(raw_token).slice(0, 16);
        await this._token_repo.update_hash(body.token_id!, token_hash, prefix);

        this.ok(res, {
            type: 'user',
            token: raw_token,
            permissions: token.permissions,
        });
    });

    /**
     * Introspect a plaintext user/realm token (daemon Hub-identity check).
     * Caller must present their own Bearer; body carries the token under test.
     */
    validate_token = this.wrap(async (req: Request, res: Response) => {
        this._require_auth(req);
        const body = this.parse_body(validate_token_schema, req);
        const plaintext = body.token.trim();

        if (plaintext.startsWith('cliq_dt_')) {
            const row = await this._token_repo.find_by_hash(sha256_hex(plaintext));
            if (!row || (row.type !== 'realm' && row.type !== 'daemon')) {
                this.ok(res, { valid: false, type: 'realm' });
                return;
            }
            const grant = row.permissions as Token_grant;
            this.ok(res, {
                valid: true,
                type: row.type,
                realm_id: primary_realm_id(grant),
                realm_ids: Array.isArray(grant.domains?.realms) ? grant.domains.realms : undefined,
                token_id: row.id,
                permissions: row.permissions,
            });
            return;
        }

        if (!plaintext.startsWith('cliq_tok_')) {
            this.ok(res, { valid: false });
            return;
        }

        const prefix = sha256_hex(plaintext).slice(0, 16);
        const row = await this._token_repo.find_by_prefix(prefix);
        if (!row || row.type !== 'user') {
            this.ok(res, { valid: false, type: 'user' });
            return;
        }
        const match = await verify_password(plaintext, row.token_hash);
        if (!match) {
            this.ok(res, { valid: false, type: 'user' });
            return;
        }
        this.ok(res, {
            valid: true,
            type: 'user',
            token_id: row.id,
            user_id: row.user_id,
            permissions: row.permissions,
        });
    });
}
