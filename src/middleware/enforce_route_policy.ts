/**
 * Applies the route policy table (`auth/route_policy/table.ts`) to every request.
 *
 * Mounted once in `app.ts`, right after the token is read. It replaces the
 * old per-route `auth` argument and the daemon-token path allowlist: daemon
 * tokens reach only routes whose policy says so (`daemon_self`, `daemon_realm`,
 * or `daemon: 'read' | 'write' | 'only'`).
 *
 * Always enforced: 401 / 403 / 404 / 400 as the policy says. This is the only
 * access check for the realm, org and site-admin rules — handlers keep only
 * the checks that need data the policy cannot see (see `handler:` notes in the
 * table). There is deliberately no switch to turn it off.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

import { get_logger } from '../lib/log.js';
import { ROUTE_POLICY } from '../auth/route_policy/table.js';
import { decide, type AccessGrant, type AccessStore, type Decision } from '../auth/route_policy/engine.js';
import type { Policy } from '../auth/route_policy/policy.js';

declare global {
    namespace Express {
        interface Request {
            /** Filled by `enforce_route_policy`: the org, realm, level and record the caller was checked against. */
            access?: AccessGrant;
        }
    }
}

const log = get_logger('auth.route_policy');

export function allow_pat_daemon_writes(raw = process.env.ALLOW_PAT_DAEMON_WRITES): boolean {
    const v = raw?.trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off');
}

interface Compiled { key: string; method: string; re: RegExp; names: string[]; policy: Policy }

export function compile_policy_table(table: Record<string, Policy>): { exact: Map<string, Policy>; patterns: Compiled[] } {
    const exact = new Map<string, Policy>();
    const patterns: Compiled[] = [];
    for (const [key, policy] of Object.entries(table)) {
        if (!key.includes(':')) { exact.set(key, policy); continue; }
        const [method, path] = key.split(' ');
        const names: string[] = [];
        const re = new RegExp('^' + path.replace(/[.]/g, '\\.').replace(/:(\w+)/g, (_m, n) => { names.push(n); return '([^/]+)'; }) + '$');
        patterns.push({ key, method, re, names, policy });
    }
    return { exact, patterns };
}

export function lookup_policy(
    compiled: ReturnType<typeof compile_policy_table>,
    method: string,
    path: string,
): { key: string; policy: Policy; params: Record<string, string> } | null {
    const m = method === 'HEAD' ? 'GET' : method;
    const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    const key = `${m} ${trimmed}`;
    const hit = compiled.exact.get(key);
    if (hit) return { key, policy: hit, params: {} };
    for (const p of compiled.patterns) {
        if (p.method !== m) continue;
        const match = p.re.exec(trimmed);
        if (match) {
            const params: Record<string, string> = {};
            p.names.forEach((n, i) => { params[n] = decodeURIComponent(match[i + 1]); });
            return { key: p.key, policy: p.policy, params };
        }
    }
    return null;
}

const MESSAGE: Record<number, [string, string]> = {
    400: ['bad_request', 'realm_id or org_id is required'],
    401: ['unauthorized', 'Authentication required'],
    403: ['forbidden', 'You do not have access to do this'],
    404: ['not_found', 'Not found'],
};

export interface RoutePolicyOptions {
    store: AccessStore;
    allow_pat_daemon_writes?: boolean;
    table?: Record<string, Policy>;
}

export function create_route_policy_middleware(opts: RoutePolicyOptions): RequestHandler {
    const compiled = compile_policy_table(opts.table ?? ROUTE_POLICY);
    const engine_opts = { allow_pat_daemon_writes: opts.allow_pat_daemon_writes ?? allow_pat_daemon_writes() };

    return async (req: Request, res: Response, next: NextFunction) => {
        const found = lookup_policy(compiled, req.method, req.path);
        if (!found) return next(); // no such route → the router answers route_not_found

        const ctx = {
            request_id: req.request_id,
            route: found.key,
            policy: found.policy.kind,
            user_id: req.auth?.user?.id,
            auth_via: req.auth?.auth_via,
            token_realm_id: req.auth?.realm_id,
        };

        let d: Decision;
        try {
            d = await decide(found.policy, {
                method: req.method, path: req.path, body: req.body, query: req.query,
                params: found.params, auth: req.auth,
            }, opts.store, engine_opts);
        } catch (err) {
            log.error('policy_error', { ...ctx, error: err instanceof Error ? err.message : String(err) });
            return next(err);
        }

        if (d.allow) {
            req.access = d.access;
            if (d.access.pat_daemon_write) {
                log.warn('pat_daemon_write', { ...ctx, realm_id: d.access.realm_id, note: 'user token pushed daemon state; removed in Core API 6' });
            }
            if (d.unresolved) log.debug('policy_unresolved', { ...ctx, note: d.unresolved });
            log.debug('access_allowed', { ...ctx, realm_id: d.access.realm_id, org_id: d.access.org_id, level: d.access.level, record: d.access.record });
            return next();
        }

        const deny_ctx = { ...ctx, status: d.status, reason: d.reason, detail: d.detail, realm_id: d.access?.realm_id, org_id: d.access?.org_id, record: d.access?.record };
        log.warn('access_denied', deny_ctx);
        const [code, message] = MESSAGE[d.status];
        res.status(d.status).json({ ok: false, error: { code, message } });
    };
}

/** Compare mounted routes with the table. `missing` = routes with no policy. */
export function check_route_policies(routes: string[], table: Record<string, Policy> = ROUTE_POLICY): { missing: string[]; stale: string[] } {
    const have = new Set(Object.keys(table));
    const mounted = new Set(routes);
    return {
        missing: routes.filter((r) => !have.has(r)),
        stale: [...have].filter((k) => !mounted.has(k)).sort(),
    };
}
