/**
 * Core API 5 — realms route file. Org owners and admins act as realm admin on
 * every realm of their org without being added (decision 2); everyone else
 * needs a membership; other orgs get 404. Production app, default mode.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { Realm, RealmMember } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('realms access (Core API 5)', () => {
    let app: Express;
    let s: Seed;
    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        const r = request(app).post(path).send(body);
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    const ids = (res: request.Response) => ((res.body.data?.items ?? []) as Array<{ id: string }>).map((r) => r.id);

    beforeAll(async () => {
        const live = await open_live_hub_app();
        app = live.app;
        s = await seed_authz(app);
    }, 300_000);

    afterAll(async () => {
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    describe('org owners and admins without a membership', () => {
        it('owner reads the realm, its members, and lists it', async () => {
            const got = await post('/v1/realms/get_by_id', s.token.olivia, { realm_id: s.A1 });
            expect(got.status).toBe(200);
            expect(got.body.realm.id).toBe(s.A1);
            expect((await post('/v1/realms/get_by_id', s.token.olivia, { slug: `a1${s.stamp}`, org_id: s.acme })).status).toBe(200);
            const members = await post('/v1/realms/get_members', s.token.olivia, { realm_id: s.A1 });
            expect(members.status).toBe(200);
            const users = ((members.body.members ?? members.body.data?.members ?? []) as Array<{ member_type: string; username: string | null }>)
                .filter((m) => m.member_type === 'user');
            expect(users.length).toBeGreaterThan(0);
            expect(users.every((m) => typeof m.username === 'string' && m.username.length > 0)).toBe(true);
            const listed = await post('/v1/realms/get', s.token.olivia, { org_id: s.acme });
            expect(ids(listed)).toEqual(expect.arrayContaining([s.A1, s.A2]));
        });

        it('owner and org admin can administer it', async () => {
            expect((await post('/v1/realms/update', s.token.olivia, { realm_id: s.A1, name: 'A1 renamed' })).status).toBe(200);
            expect((await Realm.findOne({ where: { id: s.A1 }, raw: true }))?.name).toBe('A1 renamed');
            expect((await post('/v1/realms/add_member', s.token.adam, { realm_id: s.A1, member_type: 'user', member_id: s.user.nora, role: 'member' })).status).toBe(200);
            expect(await RealmMember.findOne({ where: { realm_id: s.A1, member_id: s.user.nora } })).toBeTruthy();
            expect((await post('/v1/realms/remove_member', s.token.adam, { realm_id: s.A1, member_type: 'user', member_id: s.user.nora })).status).toBe(200);
            expect((await post('/v1/realms/a2a', s.token.olivia, { realm_id: s.A1, action: 'get' })).status).toBe(200);
        });

        it('the BFF telemetry path works for the owner: run + its realm', async () => {
            expect((await post('/v1/runs/get_by_id', s.token.olivia, { run_id: s.run_a1 })).status).toBe(200);
            expect((await post('/v1/realms/get_by_id', s.token.olivia, { realm_id: s.A1 })).status).toBe(200);
        });
    });

    describe('members by role', () => {
        it('viewer reads but cannot administer', async () => {
            expect((await post('/v1/realms/get_by_id', s.token.mia, { realm_id: s.A1 })).status).toBe(200);
            expect((await post('/v1/realms/update', s.token.mia, { realm_id: s.A1, name: 'nope' })).status).toBe(403);
            expect((await post('/v1/realms/add_member', s.token.mia, { realm_id: s.A1, member_type: 'user', member_id: s.user.nora })).status).toBe(403);
            expect((await post('/v1/realms/a2a', s.token.mia, { realm_id: s.A1, action: 'get' })).status).toBe(403);
        });

        it('operator cannot administer either', async () => {
            expect((await post('/v1/realms/delete', s.token.omar, { realm_id: s.A1 })).status).toBe(403);
        });
    });

    describe('outsiders', () => {
        it('org member without a membership: hidden realm, not in the list', async () => {
            expect((await post('/v1/realms/get_by_id', s.token.nora, { realm_id: s.A1 })).status).toBe(404);
            const listed = await post('/v1/realms/get', s.token.nora, { org_id: s.acme });
            expect(listed.status).toBe(200);
            expect(ids(listed)).not.toContain(s.A1);
        });

        it('another org: 404 on read and write, 404 listing their org', async () => {
            expect((await post('/v1/realms/get_by_id', s.token.ben, { realm_id: s.A1 })).status).toBe(404);
            expect((await post('/v1/realms/update', s.token.ben, { realm_id: s.A1, name: 'x' })).status).toBe(404);
            expect((await post('/v1/realms/get', s.token.ben, { org_id: s.acme })).status).toBe(404);
        });

        it('daemon tokens cannot use realm routes', async () => {
            expect((await post('/v1/realms/get_by_id', s.token.dA, { realm_id: s.A1 })).status).toBe(403);
        });
    });

    it('org admin can delete a realm of the org (last, destructive)', async () => {
        expect((await post('/v1/realms/delete', s.token.adam, { realm_id: s.A2 })).status).toBe(200);
        expect((await post('/v1/realms/get_by_id', s.token.olivia, { realm_id: s.A2 })).status).toBe(404);
    });
});
