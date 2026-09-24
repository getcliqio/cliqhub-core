import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';
import * as jose from 'jose';

import type { SyncEnvConfig } from '../config/env.js';
import { SyncError } from './error_handler.js';

/**
 * Auth context attached to authenticated daemon requests.
 */
export interface DaemonAuthContext {
    daemon_id: string;
    realm_id: string;
    scope_id: string;
}

declare global {
    namespace Express {
        interface Request {
            daemon_auth?: DaemonAuthContext;
        }
    }
}

const DAEMON_TOKEN_PREFIX = 'cliq_dt_';

/**
 * Middleware that validates daemon auth tokens.
 * Supports two formats:
 *   - Opaque daemon tokens (`cliq_dt_…`) — validated via DB lookup.
 *   - JWTs signed with JWT_SECRET — validated via signature verification.
 */
export function create_daemon_auth(config: SyncEnvConfig, pool: pg.Pool) {
    const jwt_secret = new TextEncoder().encode(config.jwt_secret);

    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) {
            throw new SyncError(401, 'unauthorized', 'Missing Authorization header');
        }

        const token = header.slice(7);

        try {
            if (token.startsWith(DAEMON_TOKEN_PREFIX)) {
                req.daemon_auth = await _resolve_daemon_token(pool, token, req);
            } else {
                req.daemon_auth = await _resolve_jwt(jwt_secret, token);
            }
            next();
        } catch (err) {
            if (err instanceof SyncError) {
                throw err;
            }
            throw new SyncError(401, 'invalid_token', 'Invalid or expired token');
        }
    };
}

/**
 * Resolve an opaque `cliq_dt_` token by hashing and looking up in the tokens table.
 * Extracts realm_id from the token's permissions. daemon_id comes from the request body.
 */
async function _resolve_daemon_token(
    pool: pg.Pool,
    plaintext: string,
    req: Request,
): Promise<DaemonAuthContext> {
    const token_hash = createHash('sha256').update(plaintext).digest('hex');

    const result = await pool.query<{
        permissions: Record<string, unknown> | null;
        revoked_at: string | null;
    }>(`
        SELECT permissions, revoked_at FROM tokens
        WHERE token_hash = $1 AND type IN ('realm', 'daemon')
        LIMIT 1
    `, [token_hash]);

    const row = result.rows[0];
    if (!row || row.revoked_at) {
        throw new SyncError(401, 'invalid_token', 'Invalid or revoked daemon token');
    }

    const realm_id = _extract_realm_id(row.permissions);
    if (!realm_id) {
        throw new SyncError(401, 'invalid_token', 'Token has no realm scope');
    }

    // daemon_id is self-reported in the request body
    const daemon_id = req.body?.daemon_id as string | undefined;
    if (!daemon_id) {
        throw new SyncError(400, 'missing_daemon_id', 'Request body must include daemon_id');
    }

    return { daemon_id, realm_id, scope_id: realm_id };
}

/** Resolve a JWT token by verifying its signature and extracting claims. */
async function _resolve_jwt(
    secret: Uint8Array,
    token: string,
): Promise<DaemonAuthContext> {
    const { payload } = await jose.jwtVerify(token, secret);

    const daemon_id = payload.daemon_id as string | undefined;
    const realm_id = payload.realm_id as string | undefined;
    const scope_id = (payload.scope_id ?? payload.sub) as string | undefined;

    if (!daemon_id || !realm_id) {
        throw new SyncError(401, 'invalid_token', 'Token missing required claims');
    }

    return { daemon_id, realm_id, scope_id: scope_id ?? realm_id };
}

/** Extract the first realm_id from token permissions (matches backend logic). */
function _extract_realm_id(permissions: Record<string, unknown> | null): string | null {
    if (!permissions) return null;
    const domains = permissions.domains as { realms?: unknown } | undefined;
    if (!domains) return null;
    const realms = domains.realms;
    if (!Array.isArray(realms)) return null;
    const first = realms.find((r): r is string => typeof r === 'string' && r !== '*');
    return first ?? null;
}
