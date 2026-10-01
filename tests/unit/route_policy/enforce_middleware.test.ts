/**
 * enforce_route_policy middleware — always enforced, lookup, logging, start-up check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';

import { create_route_policy_middleware, check_route_policies, lookup_policy, compile_policy_table } from '../../../src/middleware/enforce_route_policy.js';
import { mount, list_routes } from '../../../src/auth/route_policy/registry.js';
import { record, signed_in, public_, type Policy } from '../../../src/auth/route_policy/policy.js';
import type { AccessStore } from '../../../src/auth/route_policy/engine.js';
import * as logmod from '../../../src/lib/log.js';

const TABLE: Record<string, Policy> = {
    'POST /v1/runs/get_by_id': record('run', 'body.run_id', 'view'),
    'POST /v1/me': signed_in(),
    'GET /a2a/o/:org/r/:slug/card': public_(),
};

const store: AccessStore = {
    realm: async (id) => (id === 'A1' ? { id: 'A1', org_id: 'acme', owner_user_id: null } : null),
    realm_by_slug: async () => null,
    realm_role: async (_r, u) => (u === 'mia' ? 'member' : null),
    org_role: async () => null,
    org_id_by_slug: async () => null,
    daemon_in_realm: async () => false,
    record: async (_k, id) => (id === 'r1' ? { realm_id: 'A1' } : id === 'boom' ? Promise.reject(new Error('db down')) : null),
};

const lines: Array<{ level: string; msg: string; ctx?: Record<string, unknown> }> = [];

function app_with(_mode: 'enforce', user?: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.request_id = 'rid';
        if (user) req.auth = { user: { id: user, role: 'user' }, auth_via: 'pat', org_ids: [], org_slugs: [], scopes: [] } as never;
        next();
    });
    app.use(create_route_policy_middleware({ store, table: TABLE, allow_pat_daemon_writes: true }));
    const r = Router();
    r.post('/runs/get_by_id', (req, res) => { res.json({ ok: true, access: req.access ?? null }); });
    r.post('/me', (_req, res) => { res.json({ ok: true }); });
    r.post('/other', (_req, res) => { res.json({ ok: true, other: true }); });
    app.use('/v1', r);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ ok: false, error: { message: err.message } });
    });
    return app;
}

beforeEach(() => {
    lines.length = 0;
    vi.spyOn(console, 'warn').mockImplementation((s: string) => { lines.push(JSON.parse(s)); });
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((s: string) => { lines.push(JSON.parse(s)); });
    logmod.configure_hub_logging('debug');
});

describe('enforce mode', () => {
    it('401 without a token, JSON envelope, one access_denied warn', async () => {
        const res = await request(app_with('enforce')).post('/v1/me').send({});
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ ok: false, error: { code: 'unauthorized', message: 'Authentication required' } });
        const denied = lines.filter((l) => l.msg === 'access_denied');
        expect(denied).toHaveLength(1);
        expect(denied[0].ctx).toMatchObject({ route: 'POST /v1/me', reason: 'no_token', request_id: 'rid' });
    });
    it('404 for a record you cannot see', async () => {
        const res = await request(app_with('enforce', 'ben')).post('/v1/runs/get_by_id').send({ run_id: 'r1' });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('not_found');
    });
    it('allowed requests carry req.access', async () => {
        const res = await request(app_with('enforce', 'mia')).post('/v1/runs/get_by_id').send({ run_id: 'r1' });
        expect(res.status).toBe(200);
        expect(res.body.access).toMatchObject({ realm_id: 'A1', org_id: 'acme', level: 'view', record: { kind: 'run', id: 'r1' } });
    });
    it('store failure is a 500 and an error log', async () => {
        const res = await request(app_with('enforce', 'mia')).post('/v1/runs/get_by_id').send({ run_id: 'boom' });
        expect(res.status).toBe(500);
        expect(lines.some((l) => l.level === 'ERROR' && l.msg === 'policy_error')).toBe(true);
    });
    it('routes not in the table pass through (the router answers)', async () => {
        const res = await request(app_with('enforce')).post('/v1/other').send({});
        expect(res.body).toEqual({ ok: true, other: true });
    });
});

describe('no switch to turn it off', () => {
    it('ROUTE_POLICY_MODE=off or shadow is ignored', async () => {
        for (const v of ['off', 'shadow']) {
            process.env.ROUTE_POLICY_MODE = v;
            const res = await request(app_with('enforce', 'ben')).post('/v1/runs/get_by_id').send({ run_id: 'r1' });
            expect(res.status).toBe(404);
        }
        delete process.env.ROUTE_POLICY_MODE;
    });
});

describe('lookup', () => {
    const compiled = compile_policy_table(TABLE);
    it('exact, trailing slash, HEAD as GET, path parameters', () => {
        expect(lookup_policy(compiled, 'POST', '/v1/me')?.key).toBe('POST /v1/me');
        expect(lookup_policy(compiled, 'POST', '/v1/me/')?.key).toBe('POST /v1/me');
        expect(lookup_policy(compiled, 'HEAD', '/a2a/o/acme/r/prod/card')).toMatchObject({
            key: 'GET /a2a/o/:org/r/:slug/card', params: { org: 'acme', slug: 'prod' },
        });
        expect(lookup_policy(compiled, 'GET', '/v1/me')).toBeNull();
    });
});

describe('start-up check', () => {
    it('reports routes without a policy and stale policies', () => {
        const app = express();
        const r = Router();
        r.post('/runs/get_by_id', (_q, s) => { s.end(); });
        r.post('/new_thing', (_q, s) => { s.end(); });
        mount(app, '/v1', r);
        const routes = list_routes(app);
        expect(routes).toEqual(['POST /v1/new_thing', 'POST /v1/runs/get_by_id']);
        expect(check_route_policies(routes, TABLE)).toEqual({
            missing: ['POST /v1/new_thing'],
            stale: ['GET /a2a/o/:org/r/:slug/card', 'POST /v1/me'],
        });
    });
});
