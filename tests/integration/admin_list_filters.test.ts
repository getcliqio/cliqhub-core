/**
 * Admin list filters by org and realm — over HTTP on live Postgres (full
 * production app, route policy enforced). The site admin (sam) lists
 * hub-wide; org_id / realm_id narrow:
 *
 *   1. workspaces/get: a workspace belongs to a realm / org through its
 *      daemon's realm memberships or the runs it ran; rows carry the
 *      daemons, realms and orgs they run on.
 *   2. teams/get (site-admin inventory): org_id = published under a scope of
 *      the org, installed_realm_id = installed on a daemon of the realm;
 *      rows carry org_id.
 *   3. daemons/get and runs/get with all + realm_id stay inside the realm.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { DaemonTeam, Org, Realm, Scope, Team } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();

type Row = Record<string, unknown>;

describe.skipIf(!has_postgres)('admin list filters by org and realm', () => {
    let app: Express;
    let s: Seed;
    let team_id: string;
    let team_name: string;
    let daemon_team_id: string;

    const post = (path: string, body: Record<string, unknown>) =>
        request(app).post(path).set('Authorization', `Bearer ${s.token.sam}`).send(body);
    const items_of = (res: request.Response): Row[] => (res.body.data?.items ?? res.body.workspaces ?? []) as Row[];

    beforeAll(async () => {
        const live = await open_live_hub_app();
        app = live.app;
        s = await seed_authz(app);
        const scope = await Scope.findOne({ where: { org_id: s.acme }, attributes: ['id', 'slug'], raw: true }) as unknown as { id: string; slug: string };
        team_id = randomUUID();
        team_name = `azinst${s.stamp}`;
        await Team.create({ id: team_id, name: team_name, scope: scope.slug, visibility: 'public', listed: 1 } as never);
        daemon_team_id = randomUUID();
        const now = Date.now();
        await DaemonTeam.create({ id: daemon_team_id, daemon_id: s.daemon_a1, scope_id: scope.id, slug: team_name, manifest: '{}', created_at: now, updated_at: now } as never);
    }, 300_000);

    afterAll(async () => {
        await DaemonTeam.destroy({ where: { id: daemon_team_id } }).catch(() => {});
        await Team.destroy({ where: { id: team_id } }).catch(() => {});
        await s?.cleanup();
        await close_live_hub_app();
    });

    it('workspaces/get narrows by org and realm and says where each workspace runs', async () => {
        const ids = (res: request.Response) => items_of(res).map((w) => w.id);
        const by_acme = await post('/v1/workspaces/get', { org_id: s.acme, limit: 200 });
        expect(by_acme.status, JSON.stringify(by_acme.body)).toBe(200);
        expect(ids(by_acme)).toContain(s.workspace_a1);
        // Its run in B1 ties it to beta too.
        expect(ids(await post('/v1/workspaces/get', { org_id: s.beta, limit: 200 }))).toContain(s.workspace_a1);
        expect(ids(await post('/v1/workspaces/get', { realm_id: s.A1, limit: 200 }))).toContain(s.workspace_a1);
        expect(ids(await post('/v1/workspaces/get', { realm_id: s.A2, limit: 200 }))).not.toContain(s.workspace_a1);
        expect(ids(await post('/v1/workspaces/get', { org_id: randomUUID(), limit: 200 }))).toEqual([]);

        const row = items_of(by_acme).find((w) => w.id === s.workspace_a1)!;
        expect((row.daemons as Row[]).map((d) => d.id)).toEqual([s.daemon_a1]);
        expect((row.realms as Row[]).map((r) => r.id).sort()).toEqual([s.A1, s.B1].sort());
        expect((row.realms as Row[]).find((r) => r.id === s.A1)!.org_id).toBe(s.acme);
        expect((row.orgs as Row[]).map((o) => o.id).sort()).toEqual([s.acme, s.beta].sort());
    });

    it('teams/get (site-admin inventory) narrows by owning org and by realm installs, with org_id per row', async () => {
        const names = (res: request.Response) => items_of(res).map((t) => t.name);
        const by_acme = await post('/v1/teams/get', { listed: true, org_id: s.acme, limit: 100 });
        expect(by_acme.status, JSON.stringify(by_acme.body)).toBe(200);
        expect(names(by_acme)).toContain(team_name);
        const acme_slug = (await Org.findByPk(s.acme, { attributes: ['slug'], raw: true }) as unknown as { slug: string }).slug;
        expect(items_of(by_acme).find((t) => t.name === team_name)).toMatchObject({ org_id: s.acme, org_slug: acme_slug });
        const scopes = await post('/v1/orgs/get_scopes', { org_id: s.acme, limit: 100 });
        expect(scopes.status, JSON.stringify(scopes.body)).toBe(200);
        const scope_rows = (scopes.body.data?.scopes ?? scopes.body.scopes) as Row[];
        expect(scope_rows.length).toBeGreaterThan(0);
        expect(scope_rows.every((r) => r.org_slug === acme_slug)).toBe(true);
        expect(names(await post('/v1/teams/get', { listed: true, org_id: s.beta, limit: 100 }))).not.toContain(team_name);
        expect(names(await post('/v1/teams/get', { listed: true, installed_realm_id: s.A1, limit: 100 }))).toEqual([team_name]);
        expect(names(await post('/v1/teams/get', { listed: true, installed_realm_id: s.B1, limit: 100 }))).not.toContain(team_name);
    });

    it('realms/get_by_id and orgs/get label a picked realm / org for a site admin outside them', async () => {
        const b1 = await post('/v1/realms/get_by_id', { realm_id: s.B1 });
        expect(b1.status, JSON.stringify(b1.body)).toBe(200);
        expect(b1.body.realm.id).toBe(s.B1);
        const beta_slug = (await Org.findByPk(s.beta, { attributes: ['slug'], raw: true }) as unknown as { slug: string }).slug;
        const found = await post('/v1/orgs/get', { query: beta_slug, limit: 10 });
        expect(found.status, JSON.stringify(found.body)).toBe(200);
        const orgs = (found.body.data?.orgs ?? found.body.orgs) as Row[];
        expect(orgs.map((o) => o.id)).toContain(s.beta);
        expect(orgs.length).toBeLessThanOrEqual(10);
    });

    it('daemons/get and runs/get with all + realm_id stay inside the realm', async () => {
        const daemons = await post('/v1/daemons/get', { all: true, realm_id: s.A1, limit: 100 });
        expect(daemons.status, JSON.stringify(daemons.body)).toBe(200);
        expect(items_of(daemons).map((d) => d.id)).toEqual([s.daemon_a1]);
        const runs = await post('/v1/runs/get', { all: true, realm_id: s.A1, limit: 100 });
        expect(runs.status, JSON.stringify(runs.body)).toBe(200);
        expect(items_of(runs).map((r) => r.run_id)).toEqual([s.run_a1]);
        const [a1, acme] = await Promise.all([Realm.findByPk(s.A1, { raw: true }), Org.findByPk(s.acme, { raw: true })]) as unknown as Array<{ slug: string }>;
        expect(items_of(runs)[0]).toMatchObject({ realm_slug: a1.slug, org_slug: acme.slug });
    });
});
