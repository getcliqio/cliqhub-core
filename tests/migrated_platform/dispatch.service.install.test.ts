import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { randomUUID } from 'node:crypto';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { publish_version } from './helpers/version_files.js';
import {
    Daemon,
    Realm,
    RealmMember,
    DaemonTeam,
    Team,
    TeamVersion,
} from '../../src/models/index.js';
import { Scope } from '../../src/models/index.js';
import { DispatchService } from '../../src/services/dispatch.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { RealmTeamListService } from '../../src/services/realm_team_list.service.js';
import { ApiError } from '../../src/lib/api_error.js';
import * as outbox from '../../src/services/command_outbox.service.js';

const has_postgres = await postgres_reachable();

const uid = () => `dinst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('DispatchService.install_team (command outbox)', () => {
    const org_id = uid();
    /** Seeded numeric user id — RealmService.create needs a real user row
     *  to resolve/create a personal org for the NOT NULL realms.org_id. */
    const user_id = hub_legacy_uuid(1);
    let scope_id: string;
    let team_id: string;      // a catalog team on the realm's list
    let version_id: string;   // the version the realm runs
    let realm_id: string;
    let d1: string;
    let d2: string;
    let d_out: string;        // a daemon in no realm
    const catalog_ids: string[] = [];
    /** Spy on outbox enqueue — install now goes through the durable outbox. */
    const mock_enqueue = vi.fn();

    beforeAll(async () => {
        if (!has_postgres) return;
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
        mock_enqueue.mockResolvedValue({ tx_id: 'test-tx-id' });
        vi.spyOn(outbox, 'command_outbox_enqueue').mockImplementation(mock_enqueue);

        const scope = await Scope.create({
            id: randomUUID(),
            slug: `inst-${uid()}`.slice(0, 40),
            display_name: 'install-scope',
            owner_id: null,
            org_id: null,
            is_default: 0,
            created_at: new Date(),
        });
        scope_id = scope.id;

        // A published catalog team, on the realm's list (PLAN-team-bundle S4.2: daemons install realm teams only).
        const name = `t-${uid()}`.slice(0, 40);
        const team = await Team.create({
            id: randomUUID(), name, scope: scope.slug, description: 't',
            author_id: user_id, license: 'MIT', visibility: 'public', listed: 1, install_count: 0,
        } as any);
        team_id = team.id;
        catalog_ids.push(team_id);
        version_id = await publish_version(team_id, '1.0.0', { name: `@${scope.slug}/${name}`, phases: [] });

        const realm = await RealmService.create(user_id, `inst-${uid()}`.slice(0, 40), 'Install Realm');
        realm_id = realm.id;
        await RealmTeamListService.add(realm_id, user_id, { team_id });

        d1 = uid();
        d2 = uid();
        d_out = uid();
        for (const id of [d1, d2, d_out]) {
            await Daemon.create({
                id,
                api_key_hash: 'h',
                user_id: null,
                user_email: null,
                hostname: 'pod',
                ip: '127.0.0.1',
                port: 4900,
                public_url: `https://daemon.test/${id}`,
                status: 'online',
                last_heartbeat: Date.now(),
                capacity: 5,
                created_at: Date.now(),
                last_registered_at: Date.now(),
            });
            if (id !== d_out) await RealmService.upsert_daemon_member(realm_id, id);
        }
    });

    beforeEach(() => {
        mock_enqueue.mockReset();
        mock_enqueue.mockResolvedValue({ tx_id: 'test-tx-id' });
    });

    afterAll(async () => {
        if (!has_postgres) return;
        vi.restoreAllMocks();
        await RealmMember.destroy({ where: { realm_id } });
        await Realm.destroy({ where: { id: realm_id } });
        await Daemon.destroy({ where: { id: d1 } });
        await Daemon.destroy({ where: { id: [d2, d_out] } });
        await TeamVersion.destroy({ where: { team_id: catalog_ids } });
        await DaemonTeam.unscoped().destroy({ where: { scope_id } });
        await Team.destroy({ where: { id: catalog_ids } });
        await Scope.destroy({ where: { id: scope_id } });
        await close_test_control_plane_store();
    });

    /** The daemon's live row for the team (Core writes it when the hub installs). */
    const row_of = (daemon_id: string) => DaemonTeam.findOne({ where: { daemon_id, team_id }, raw: true }) as Promise<any>;

    it('a daemon in the realm: Core writes its row (child of the realm team) and sends catalog ids only', async () => {
        const result = await DispatchService.install_team({ team_id, daemon_ids: [d1], user_id, org_ids: [org_id] });
        expect(result.results).toEqual([{ daemon_id: d1, ok: true }]);
        const row = await row_of(d1);
        const realm_team = await RealmTeamListService.find(realm_id, team_id);
        expect(row).toMatchObject({ team_id, version_id, realm_team_id: realm_team!.id, version: '1.0.0', origin: 'hub', uninstalled_at: null });
        expect(result.team_id).toBe(row.id);
        // The daemon downloads the version by these ids and gets its row id back (teams/download).
        expect(mock_enqueue).toHaveBeenCalledWith(d1, '/v1/install', { team_id, version_id, agent_settings: undefined });
    });

    it('installing again keeps the row and its id', async () => {
        const before = await row_of(d1);
        await DispatchService.install_team({ team_id, daemon_ids: [d1], user_id, org_ids: [org_id] });
        expect((await row_of(d1)).id).toBe(before.id);
        expect(await DaemonTeam.unscoped().count({ where: { daemon_id: d1, team_id } })).toBe(1);
    });

    it("a daemon whose realm doesn't run the team gets nothing: no row, no install", async () => {
        await expect(DispatchService.install_team({ team_id, daemon_ids: [d_out], user_id, org_ids: [org_id] }))
            .rejects.toThrow(/isn't on this daemon's realm\. Add it to the realm first/);
        expect(await row_of(d_out)).toBeNull();
        expect(mock_enqueue).not.toHaveBeenCalled();
    });

    it("a daemon_teams id installs its catalog team", async () => {
        const row = await row_of(d1);
        const result = await DispatchService.install_team({ team_id: row.id, daemon_ids: [d2], user_id, org_ids: [org_id] });
        expect(result.results[0].ok).toBe(true);
        expect(mock_enqueue).toHaveBeenCalledWith(d2, '/v1/install', { team_id, version_id, agent_settings: undefined });
    });

    it('enqueues install for each daemon_id', async () => {
        const result = await DispatchService.install_team({
            team_id,
            daemon_ids: [d1, d2],
            user_id,
            org_ids: [org_id],
        });
        expect(result.results).toHaveLength(2);
        expect(result.results.every((r) => r.ok)).toBe(true);
        expect(mock_enqueue).toHaveBeenCalledTimes(2);
    });

    it('enqueues fan-out when realm_id is set', async () => {
        const result = await DispatchService.install_team({
            team_id,
            realm_id,
            user_id,
            org_ids: [org_id],
        });
        expect(result.results).toHaveLength(2);
        expect(result.results.every((r) => r.ok)).toBe(true);
        expect(mock_enqueue).toHaveBeenCalledTimes(2);
    });

    it('requires daemon_ids or realm_id', async () => {
        await expect(DispatchService.install_team({
            team_id,
            user_id,
            org_ids: [org_id],
        })).rejects.toThrow(/daemon_ids or realm_id/);
    });

    it('rejects both daemon_ids and realm_id', async () => {
        await expect(DispatchService.install_team({
            team_id,
            daemon_ids: [d1],
            realm_id,
            user_id,
            org_ids: [org_id],
        })).rejects.toThrow(/not both/);
    });

    /** A catalog team whose one phase is a Hug gate (PLAN-notifications-v2 B3). */
    async function publish_gate(review: Record<string, unknown> | undefined): Promise<string> {
        const scope = await Scope.findByPk(scope_id, { raw: true });
        const name = `gate-${uid()}`.slice(0, 40);
        const team = await Team.create({
            id: randomUUID(), name, scope: scope!.slug, description: 'gate',
            author_id: user_id, license: 'MIT', visibility: 'public', listed: 1, install_count: 0,
        } as any);
        catalog_ids.push(team.id);
        await publish_version(team.id, '1.0.0', {
            name: `@${scope!.slug}/${name}`,
            phases: [{ name: 'human-review', type: 'gate', agent: 'hug', ...(review ? { review } : {}) }],
        });
        await RealmTeamListService.add(realm_id, user_id, { team_id: team.id });
        return `${scope!.slug}/${name}`;
    }

    it('B3: a Hug gate with no reviewers can\'t be installed', async () => {
        const team = await publish_gate(undefined);
        await expect(DispatchService.install_team({ team_id: team, daemon_ids: [d1], user_id, org_ids: [org_id] }))
            .rejects.toMatchObject({ status: 422, message: expect.stringContaining('must declare review.reviewers') });
        expect(mock_enqueue).not.toHaveBeenCalled();
    });

    it('B3: a Hug gate with reviewers installs', async () => {
        const team = await publish_gate({ reviewers: [{ policy: 'any', channels: ['qa'] }] });
        const result = await DispatchService.install_team({ team_id: team, daemon_ids: [d1], user_id, org_ids: [org_id] });
        expect(result.results[0].ok).toBe(true);
        expect(mock_enqueue).toHaveBeenCalledTimes(1);
    });
});
