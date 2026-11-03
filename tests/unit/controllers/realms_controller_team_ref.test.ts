/**
 * realms/add_team and remove_team name the team by its catalog id (PLAN-team-bundle S4.1): `{ realm_id, team_id,
 * version_id? }`. The old `{ scope, slug, version }` body is refused, not half-read.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

vi.mock('../../../src/services/realm.service.js', () => ({ RealmService: {} }));
vi.mock('../../../src/services/realm_team_list.service.js', () => ({ RealmTeamListService: {} }));
vi.mock('../../../src/services/dispatch.service.js', () => ({ DispatchService: {} }));
vi.mock('../../../src/services/org_teams.service.js', () => ({ OrgTeamsService: { ensure_for_realm: vi.fn(async () => undefined) } }));

import { RealmController } from '../../../src/controllers/realms_controller.js';
import { OrgTeamsService } from '../../../src/services/org_teams.service.js';

const REALM = hub_legacy_uuid(30);
const TEAM = hub_legacy_uuid(40);
const VERSION = hub_legacy_uuid(41);
const LIST = [{ team_id: TEAM, version_id: VERSION, scope: 'acme', slug: 'claims', version: '1.2.0' }];

const team_list = {
    team: vi.fn(async (id: string) => ({ id, scope: 'acme', slug: 'claims' })),
    add: vi.fn(async () => LIST),
    remove: vi.fn(async () => []),
    sync_team: vi.fn(async () => ({ scope: 'acme', slug: 'claims', daemon_results: [] })),
};
const dispatch = { uninstall_team: vi.fn(async () => ({ daemons: [] })) };
const controller = new RealmController({} as never, team_list as never, dispatch as never);

const req = (body: unknown) => ({
    body, auth: { user: { id: hub_legacy_uuid(1), username: 'u', role: 'user' }, org_ids: ['o1'], org_slugs: [], scopes: [] },
}) as unknown as Request;
const res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }) as unknown as Response & { json: ReturnType<typeof vi.fn> };

describe('realms/add_team and remove_team by id', () => {
    beforeEach(() => vi.clearAllMocks());

    it('add_team: the team (and version) by id; the org check and the install use its names', async () => {
        const r = res();
        await controller.add_team(req({ realm_id: REALM, team_id: TEAM, version_id: VERSION }), r);
        expect(team_list.team).toHaveBeenCalledWith(TEAM);
        expect(OrgTeamsService.ensure_for_realm).toHaveBeenCalledWith(expect.anything(), REALM, 'acme', 'claims');
        expect(team_list.add).toHaveBeenCalledWith(REALM, hub_legacy_uuid(1), { team_id: TEAM, version_id: VERSION });
        expect(team_list.sync_team).toHaveBeenCalledWith(REALM, hub_legacy_uuid(1), TEAM, ['o1']);
        expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, team_list: LIST }));
    });

    it('add_team without a version: the service records the latest', async () => {
        await controller.add_team(req({ realm_id: REALM, team_id: TEAM }), res());
        expect(team_list.add).toHaveBeenCalledWith(REALM, hub_legacy_uuid(1), { team_id: TEAM, version_id: undefined });
    });

    it('remove_team: takes it off by id, then tells the daemons by name', async () => {
        await controller.remove_team(req({ realm_id: REALM, team_id: TEAM }), res());
        expect(team_list.remove).toHaveBeenCalledWith(REALM, hub_legacy_uuid(1), TEAM);
        expect(dispatch.uninstall_team).toHaveBeenCalledWith(expect.objectContaining({ scope: 'acme', slug: 'claims', realm_id: REALM }));
    });

    it('the old { scope, slug } body, or a team_id that is not an id, is a 422', async () => {
        for (const body of [
            { realm_id: REALM, scope: 'acme', slug: 'claims' },
            { realm_id: REALM, team_id: TEAM, scope: 'acme', slug: 'claims', version: '1.2.0' },
            { realm_id: REALM, team_id: 'acme/claims' },
        ]) {
            await expect(controller.add_team(req(body), res())).rejects.toMatchObject({ status: 422 });
        }
        await expect(controller.remove_team(req({ realm_id: REALM, scope: 'acme', slug: 'claims' }), res())).rejects.toMatchObject({ status: 422 });
        expect(team_list.add).not.toHaveBeenCalled();
        expect(team_list.remove).not.toHaveBeenCalled();
    });
});
