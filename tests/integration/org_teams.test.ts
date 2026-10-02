/**
 * An org's team library on live Postgres.
 *
 *   - Someone with `teams.install` adds a marketplace team to the org; adding
 *     it again changes nothing. Members list the library.
 *   - Adding a team to a realm puts it in the realm's org as well.
 *   - Someone who cannot add teams to the org cannot get a team into a realm
 *     that the org doesn't have yet.
 *   - A team leaves the library only once none of the org's realms has it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { OrgTeam, Team } from '../../src/models/index.js';
import { OrgTeamsService } from '../../src/services/org_teams.service.js';
import type { AuthContext } from '../../src/schemas/auth_types.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('org team library', () => {
    let app: Express;
    let s: Seed;
    let name: string;

    const post = (path: string, who: keyof Seed['token'], body: Record<string, unknown>) =>
        request(app).post(path).set('Authorization', `Bearer ${s.token[who]}`).send(body);

    beforeAll(async () => {
        app = (await open_live_hub_app()).app;
        s = await seed_authz(app);
        name = (await Team.findByPk(s.team_public, { attributes: ['name'], raw: true }))!.name as string;
    }, 300_000);

    afterAll(async () => {
        await OrgTeam.destroy({ where: { org_id: s.acme } });
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    it('adds a marketplace team to the org once; members see it with no realms yet', async () => {
        const first = await post('/v1/orgs/add_team', 'omar', { org_id: s.acme, team_id: s.team_public });
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect(first.body.data).toMatchObject({ team_id: s.team_public, scope: 'cliq', name, added: true });
        const again = await post('/v1/orgs/add_team', 'omar', { org_id: s.acme, scope: 'cliq', slug: name });
        expect(again.body.data.added).toBe(false);

        const list = await post('/v1/orgs/get_teams', 'nora', { org_id: s.acme });
        expect(list.status).toBe(200);
        expect(list.body.data.items).toEqual([expect.objectContaining({ team_id: s.team_public, own: false, realms: [], added_by: expect.any(String) })]);
    });

    it("can't add a team the caller can't see", async () => {
        const res = await post('/v1/orgs/add_team', 'omar', { org_id: s.acme, team_id: s.team_private });
        expect(res.status).toBe(404);
    });

    it('a team in a realm cannot leave the org until the realm drops it', async () => {
        const added = await post('/v1/realms/add_team', 'omar', { realm_id: s.A1, scope: 'cliq', slug: name });
        expect(added.status, JSON.stringify(added.body)).toBe(200);
        const list = await post('/v1/orgs/get_teams', 'omar', { org_id: s.acme });
        expect(list.body.data.items[0].realms).toEqual([{ realm_id: s.A1, slug: expect.any(String) }]);

        const blocked = await post('/v1/orgs/remove_team', 'omar', { org_id: s.acme, team_id: s.team_public });
        expect(blocked.status).toBe(409);
        expect(blocked.body.details.realms).toEqual([{ realm_id: s.A1, slug: expect.any(String) }]);

        expect((await post('/v1/realms/remove_team', 'omar', { realm_id: s.A1, scope: 'cliq', slug: name })).status).toBe(200);
        const removed = await post('/v1/orgs/remove_team', 'omar', { org_id: s.acme, team_id: s.team_public });
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        expect(removed.body.data.removed).toBe(true);
    });

    it('adding to a realm adds to the org; without the right to add teams to the org it is refused', async () => {
        const nora = { user: { id: s.user.nora, role: 'user' } } as unknown as AuthContext;
        await expect(OrgTeamsService.ensure_for_realm(nora, s.A1, 'cliq', name)).rejects.toMatchObject({ status: 403, code: 'team_not_in_org' });
        expect(await OrgTeam.count({ where: { org_id: s.acme, team_id: s.team_public } })).toBe(0);

        const added = await post('/v1/realms/add_team', 'omar', { realm_id: s.A1, scope: 'cliq', slug: name });
        expect(added.status, JSON.stringify(added.body)).toBe(200);
        expect(await OrgTeam.count({ where: { org_id: s.acme, team_id: s.team_public } })).toBe(1);
        // Once the org has it, anyone who may change the realm's team list can add it to other realms.
        await expect(OrgTeamsService.ensure_for_realm(nora, s.A1, 'cliq', name)).resolves.toBeUndefined();
        await post('/v1/realms/remove_team', 'omar', { realm_id: s.A1, scope: 'cliq', slug: name });
    });
});
