/**
 * An org's Teams list on live Postgres (PLAN-team-visibility §3.4, §3.6).
 *
 *   - The list is a view: the org's own published teams and the `@cliq` public teams are on it with no
 *     row stored; teams from other orgs' scopes are added with `orgs/add_team` (`teams.install`).
 *   - Own and `@cliq` teams can't be added or removed; an added team leaves only once no realm has it.
 *   - A realm installs only from the list: `realms/add_team` never adds to it, even for someone who
 *     could; a team the caller can't see is refused.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { Org, OrgTeam, Scope, Team, TeamVersion } from '../../src/models/index.js';
import { OrgTeamsService } from '../../src/services/org_teams.service.js';
import type { AuthContext } from '../../src/schemas/auth_types.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('org Teams list', () => {
    let app: Express;
    let s: Seed;
    /** A @cliq public team (the seed's team_public), Acme's own team, and a public team of Beta's. */
    let cliq_name: string;
    const own = randomUUID();
    const market = randomUUID();
    let own_name: string;
    let market_name: string;
    let acme_scope: string;
    let beta_scope: string;

    const post = (path: string, who: keyof Seed['token'], body: Record<string, unknown>) =>
        request(app).post(path).set('Authorization', `Bearer ${s.token[who]}`).send(body);
    const default_scope = async (org_id: string) => {
        const org = await Org.findByPk(org_id, { attributes: ['default_scope_id'], raw: true }) as { default_scope_id: string } | null;
        return (await Scope.findByPk(org!.default_scope_id, { attributes: ['slug'], raw: true }))!.slug as string;
    };

    beforeAll(async () => {
        app = (await open_live_hub_app()).app;
        s = await seed_authz(app);
        cliq_name = (await Team.findByPk(s.team_public, { attributes: ['name'], raw: true }))!.name as string;
        acme_scope = await default_scope(s.acme);
        beta_scope = await default_scope(s.beta);
        own_name = `azown${s.stamp}`;
        market_name = `azmkt${s.stamp}`;
        await Team.create({ id: own, name: own_name, scope: acme_scope, visibility: 'public', listed: 1, author_id: s.user.olivia } as never);
        await Team.create({ id: market, name: market_name, scope: beta_scope, visibility: 'public', listed: 1, author_id: s.user.ben } as never);
        await TeamVersion.create({ team_id: market, version: '1.0.0', package_path: `${market_name}-1.0.0.zip`, workflow_json: '{"phases":[]}', manifest_yaml: `name: ${market_name}\nphases: []\n` } as never);
    }, 300_000);

    afterAll(async () => {
        await OrgTeam.destroy({ where: { org_id: s.acme } });
        await TeamVersion.destroy({ where: { team_id: market } });
        await Team.destroy({ where: { id: [own, market] } });
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    it('own and @cliq teams are on the list with no row stored', async () => {
        const list = await post('/v1/orgs/get_teams', 'nora', { org_id: s.acme });
        expect(list.status, JSON.stringify(list.body)).toBe(200);
        const items = list.body.data.items as Array<{ team_id: string; kind: string; own: boolean; added_at: string | null }>;
        expect(items.find((t) => t.team_id === own)).toMatchObject({ kind: 'own', own: true, added_at: null });
        expect(items.find((t) => t.team_id === s.team_public)).toMatchObject({ kind: 'cliq', own: false, added_at: null });
        expect(items.find((t) => t.team_id === market)).toBeUndefined();
        expect(await OrgTeam.count({ where: { org_id: s.acme } })).toBe(0);
    });

    it("own and @cliq teams can't be added or removed", async () => {
        for (const team_id of [own, s.team_public]) {
            expect((await post('/v1/orgs/add_team', 'omar', { org_id: s.acme, team_id })).status).toBe(422);
            expect((await post('/v1/orgs/remove_team', 'omar', { org_id: s.acme, team_id })).status).toBe(422);
        }
    });

    it("a realm installs only from the list: another org's team is refused until it is added", async () => {
        const omar = { user: { id: s.user.omar, role: 'user' }, member_scopes: [], publish_orgs: [] } as unknown as AuthContext;
        await expect(OrgTeamsService.ensure_for_realm(omar, s.A1, beta_scope, market_name))
            .rejects.toMatchObject({ status: 403, code: 'team_not_in_org' });
        // Not added as a side effect, though Omar holds teams.install.
        expect(await OrgTeam.count({ where: { org_id: s.acme, team_id: market } })).toBe(0);
        // Own and @cliq teams install straight away.
        await expect(OrgTeamsService.ensure_for_realm(omar, s.A1, acme_scope, own_name)).resolves.toBeUndefined();
        await expect(OrgTeamsService.ensure_for_realm(omar, s.A1, 'cliq', cliq_name)).resolves.toBeUndefined();
    });

    it('adds a team from another org once; it leaves the list only once no realm has it', async () => {
        const first = await post('/v1/orgs/add_team', 'omar', { org_id: s.acme, team_id: market });
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect(first.body.data).toMatchObject({ team_id: market, scope: beta_scope, name: market_name, added: true });
        const again = await post('/v1/orgs/add_team', 'omar', { org_id: s.acme, scope: beta_scope, slug: market_name });
        expect(again.body.data.added).toBe(false);
        const list = await post('/v1/orgs/get_teams', 'nora', { org_id: s.acme });
        expect(list.body.data.items.find((t: { team_id: string }) => t.team_id === market))
            .toMatchObject({ kind: 'added', added_by: expect.any(String), added_at: expect.any(String), realms: [] });

        const added = await post('/v1/realms/add_team', 'omar', { realm_id: s.A1, scope: beta_scope, slug: market_name });
        expect(added.status, JSON.stringify(added.body)).toBe(200);
        const blocked = await post('/v1/orgs/remove_team', 'omar', { org_id: s.acme, team_id: market });
        expect(blocked.status).toBe(409);
        expect(blocked.body.details.realms).toEqual([{ realm_id: s.A1, slug: expect.any(String) }]);

        expect((await post('/v1/realms/remove_team', 'omar', { realm_id: s.A1, scope: beta_scope, slug: market_name })).status).toBe(200);
        const removed = await post('/v1/orgs/remove_team', 'omar', { org_id: s.acme, team_id: market });
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        expect(removed.body.data.removed).toBe(true);
    });

    it("can't add, put on a realm or fleet-install a team the caller can't see", async () => {
        const id = randomUUID();
        const priv = `azprivb${s.stamp}`;
        await Team.create({ id, name: priv, scope: beta_scope, visibility: 'private', listed: 0, author_id: s.user.ben } as never);
        try {
            expect((await post('/v1/orgs/add_team', 'omar', { org_id: s.acme, team_id: id })).status).toBe(404);
            const added = await post('/v1/realms/add_team', 'omar', { realm_id: s.A1, scope: beta_scope, slug: priv });
            expect(added.status, JSON.stringify(added.body)).toBe(404);
            const installed = await post('/v1/teams/install', 'omar', { team_id: id, realm_id: s.A1 });
            expect(installed.status, JSON.stringify(installed.body)).toBe(404);
        } finally {
            await Team.destroy({ where: { id } });
        }
    });
});
