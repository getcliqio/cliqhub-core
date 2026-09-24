/**
 * Hub Bearer auth — exactly two credential kinds (no Hub session JWT):
 *
 *   - `cliq_tok_…`  user PAT (incl. BFF session-scoped PATs)
 *   - `cliq_dt_…`   realm / daemon token
 *
 * Browser sessions are owned by the BFF (`session_id` cookie). The BFF
 * forwards `Authorization: Bearer <target_token>` (a `cliq_tok_…`) on
 * data-plane calls. Reject anything else (JWT, `cliq_dk_…`, bare secrets).
 */

import type { Request, Response, NextFunction } from 'express';
import { verify_password } from '../auth/password.js';
import type { UserRepository } from '../repositories/user_repository.js';
import type { TokenRepository } from '../repositories/token_repository.js';
import type { ScopeRepository } from '../repositories/scope_repository.js';
import type { OrgMemberRepository } from '../repositories/org_member_repository.js';
import type { AuthContext, TokenPermissionsVO } from '../types/vo.js';
import { RealmService } from '../services/realm.service.js';
import crypto from 'node:crypto';

declare global {
    namespace Express {
        interface Request {
            auth: AuthContext;
        }
    }
}

interface AuthDeps {
    user_repo: UserRepository;
    token_repo: TokenRepository;
    scope_repo: ScopeRepository;
    org_member_repo: OrgMemberRepository;
}

const UNAUTHED: AuthContext = { user: null, org_slugs: [], org_ids: [], scopes: [] };

export function create_auth_middleware(deps: AuthDeps) {
    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) {
            req.auth = UNAUTHED;
            return next();
        }

        const token = header.slice(7);

        // Realm / daemon token (`cliq_dt_…`)
        if (token.startsWith('cliq_dt_')) {
            req.auth = await resolve_daemon_token(token, deps);
            req.auth.current_org_id = resolve_current_org_id(req, req.auth);
            return next();
        }

        // User PAT (`cliq_tok_…`) — includes BFF session PATs
        if (token.startsWith('cliq_tok_')) {
            req.auth = await resolve_api_token(token, deps);
            req.auth.current_org_id = resolve_current_org_id(req, req.auth);
            return next();
        }

        // JWT / cliq_dk_ / any other Bearer → unauthenticated
        req.auth = UNAUTHED;
        return next();
    };
}

async function resolve_api_token(token: string, deps: AuthDeps): Promise<AuthContext> {
    const prefix = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    const row = await deps.token_repo.find_by_prefix(prefix);
    if (!row) return UNAUTHED;
    if (row.type && row.type !== 'user') return UNAUTHED;

    const valid = await verify_password(token, row.token_hash);
    if (!valid) return UNAUTHED;

    const user = await deps.user_repo.find_by_id(row.user_id);
    if (!user) return UNAUTHED;
    if (user.suspended_at) return UNAUTHED;

    void Promise.resolve(deps.token_repo.update_last_used(String(row.id))).catch(() => {});

    const context = await build_auth_context(user.id, deps, user);
    context.auth_via = 'pat';
    // Session-scoped PATs (`session:…` name from mint_session_pat): do NOT
    // freeze token_permissions — assert_grant falls back to live membership
    // (same as former Hub JWT). Standing user PATs keep stored grants.
    const token_name = typeof (row as { name?: unknown }).name === 'string'
        ? (row as { name: string }).name
        : '';
    const is_session_pat = token_name.startsWith('session:');
    if (
        !is_session_pat
        && row.permissions
        && Object.keys(row.permissions).length > 0
    ) {
        context.token_permissions = row.permissions;
    }
    // Capability scopes (Forge/JIRA): non-empty array opts into enforcement
    // via require_token_scope. Empty = no capability-scope gate (Hub entity
    // grants live on token_permissions / default_grant_for_subject).
    const raw_scopes = (row as { scopes?: unknown }).scopes;
    if (Array.isArray(raw_scopes) && raw_scopes.length > 0) {
        context.token_scopes = raw_scopes.filter(
            (s): s is string => typeof s === 'string',
        );
    }
    return context;
}

async function resolve_daemon_token(token: string, deps: AuthDeps): Promise<AuthContext> {
    let resolved: { token_id: string; realm_id: string; created_by: string; permissions: Record<string, unknown> };
    try {
        resolved = await RealmService.resolve_token(token);
    } catch {
        return UNAUTHED;
    }

    const created_by_id = String(resolved.created_by);
    if (!created_by_id) return UNAUTHED;

    const user = await deps.user_repo.find_by_id(created_by_id);
    if (!user) return UNAUTHED;
    if (user.suspended_at) return UNAUTHED;

    const context = await build_auth_context(user.id, deps, user);
    context.auth_via = 'daemon_token';
    if (resolved.realm_id) context.realm_id = resolved.realm_id;
    if (resolved.permissions && Object.keys(resolved.permissions).length > 0) {
        context.token_permissions = resolved.permissions as TokenPermissionsVO;
    }
    return context;
}

async function build_auth_context(
    user_id: string,
    deps: AuthDeps,
    user: NonNullable<AuthContext['user']>,
): Promise<AuthContext> {
    const [user_scopes, org_memberships, member_scopes] = await Promise.all([
        deps.scope_repo.find_owned_by_user(user_id),
        deps.org_member_repo.find_orgs_by_user(user_id),
        deps.scope_repo.find_member_scopes(user_id),
    ]);

    const org_ids = org_memberships.map(o => o.org_id);
    const org_scopes = org_ids.length > 0
        ? await deps.scope_repo.find_by_org_ids(org_ids)
        : [];

    const scope_map = new Map<string, typeof user_scopes[0]>();
    for (const s of [...user_scopes, ...org_scopes, ...member_scopes]) {
        scope_map.set(s.id, s);
    }

    return {
        user,
        org_slugs: org_memberships.map(o => o.slug),
        org_ids: org_memberships.map(o => o.org_id),
        scopes: [...scope_map.values()],
    };
}

/**
 * Resolve the active org for this request. Checks `X-Org-Id` header
 * first; falls back to the user's personal org (slug === username).
 * Returns undefined if user has no org membership.
 */
export function resolve_current_org_id(
    req: { headers: Record<string, string | string[] | undefined> },
    auth: { user: { username: string } | null; org_ids: string[]; org_slugs: string[] },
): string | undefined {
    const header_val = req.headers['x-org-id'];
    if (header_val) {
        const requested = String(Array.isArray(header_val) ? header_val[0] : header_val).trim();
        if (requested && auth.org_ids.includes(requested)) {
            return requested;
        }
    }

    if (!auth.user || auth.org_ids.length === 0) return undefined;

    // Default: personal org (slug === username).
    const personal_idx = auth.org_slugs.indexOf(auth.user.username);
    if (personal_idx >= 0) return auth.org_ids[personal_idx];

    // Fallback: first org membership.
    return auth.org_ids[0];
}
