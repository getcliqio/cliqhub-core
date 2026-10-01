/**
 * Behaviour that changed when the handlers stopped repeating the route policy
 * (Core API 5, Oct 1). Production app, Acme/Beta seed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { Org, OrgMember } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('duplicate handler checks removed (Core API 5)', () => {
    let app: Express;
    let s: Seed;
    const orgs: string[] = [];
    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        const r = request(app).post(path).send({ tx_id: randomUUID(), ...body });
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };

    beforeAll(async () => {
        const live = await open_live_hub_app();
        app = live.app;
        s = await seed_authz(app);
    }, 300_000);

    afterAll(async () => {
        await OrgMember.destroy({ where: { org_id: orgs } }).catch(() => {});
        await Org.destroy({ where: { id: orgs } }).catch(() => {});
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    it('a realm operator can add a team to the realm (the service used to demand realm admin)', async () => {
        const res = await post('/v1/realms/add_team', s.token.omar, { realm_id: s.A1, scope: 'cliq', slug: `nope${s.stamp}`, version: '1.0.0' });
        expect(res.status).not.toBe(403);
        expect(JSON.stringify(res.body)).not.toContain('Realm admin role required');
        expect((await post('/v1/realms/add_team', s.token.mia, { realm_id: s.A1, scope: 'cliq', slug: 'x', version: '1.0.0' })).status).toBe(403);
    });

    it('realms/get_by_id with slug + org_slug finds the realm (was 404)', async () => {
        const acme = await Org.findOne({ where: { id: s.acme }, raw: true }) as unknown as { slug: string };
        const res = await post('/v1/realms/get_by_id', s.token.mia, { slug: `a1${s.stamp}`, org_slug: acme.slug });
        expect(res.status).toBe(200);
        expect(res.body.realm.id).toBe(s.A1);
        expect((await post('/v1/realms/get_by_id', s.token.ben, { slug: `a1${s.stamp}`, org_slug: acme.slug })).status).toBe(404);
    });

    it('orgs/new is for site admins only', async () => {
        expect((await post('/v1/orgs/new', s.token.olivia, { slug: `azn${s.stamp}`, admin_username: 'x' })).status).toBe(403);
    });

    it('an org owner can delete their org; a personal org cannot be deleted by its owner', async () => {
        const owner = await s.signup('odel');
        const slug = `azdel${s.stamp}`.slice(0, 30);
        const created = await post('/v1/orgs/new', s.token.sam, { slug, display_name: 'Del', admin_username: owner.username });
        expect(created.status).toBe(200);
        const org = await Org.findOne({ where: { slug }, raw: true }) as unknown as { id: string };
        orgs.push(org.id);

        expect((await post('/v1/orgs/delete', s.token.adam, { org_id: org.id })).status).toBe(404);
        expect((await post('/v1/orgs/delete', owner.token, { org_id: org.id })).status).toBe(200);
        expect(await Org.findOne({ where: { id: org.id } })).toBeNull();

        // Personal org: the policy already refuses (no org.delete there); the service refuses too (409).
        const personal = await post('/v1/orgs/delete', owner.token, { org_id: owner.org_id });
        expect([403, 409]).toContain(personal.status);
        expect(await Org.findOne({ where: { id: owner.org_id } })).not.toBeNull();
    });

    it('an org invite needs org.members.manage in THAT org, even when realm_id of another org is sent', async () => {
        // Ben is admin of realm B1 (Beta). The policy judges realm_id; the service still checks the org.
        const res = await post('/v1/invitations/create', s.token.ben, {
            target_type: 'org', org_id: s.acme, realm_id: s.B1, email: `x${s.stamp}@authz.test`,
        });
        expect(res.status).toBe(403);
    });

    it('route-level auth is the policy: no token → 401 with the standard envelope', async () => {
        const res = await post('/v1/realms/update', null, { realm_id: s.A1, name: 'x' });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ ok: false, error: { code: 'unauthorized', message: 'Authentication required' } });
    });
});
