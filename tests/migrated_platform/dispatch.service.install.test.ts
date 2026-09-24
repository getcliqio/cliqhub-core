import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import {
    Daemon,
    Realm,
    RealmMember,
    Scope,
    Team,
} from '../../src/models/index.js';
import { DispatchService } from '../../src/services/dispatch.service.js';
import { RealmService } from '../../src/services/realm.service.js';
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
    let team_id: string;
    let realm_id: string;
    let d1: string;
    let d2: string;
    /** Spy on outbox enqueue — install now goes through the durable outbox. */
    const mock_enqueue = vi.fn();

    beforeAll(async () => {
        if (!has_postgres) return;
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
        mock_enqueue.mockResolvedValue({ tx_id: 'test-tx-id' });
        vi.spyOn(outbox, 'command_outbox_enqueue').mockImplementation(mock_enqueue);

        const scope = await Scope.create({
            id: uid(),
            slug: `inst-${uid()}`.slice(0, 40),
            name: 'install-scope',
            org_id,
            scope_type: 'org',
            is_default: 0,
            created_at: Date.now(),
        });
        scope_id = scope.id;

        const team = await Team.create({
            id: uid(),
            scope_id,
            slug: `t-${uid()}`,
            version: '1.0.0',
            description: null,
            manifest: 'name: t\nversion: "1.0.0"\nphases: []\n',
            dockerfile: null,
            dependencies: null,
            created_at: Date.now(),
            updated_at: Date.now(),
        });
        team_id = team.id;

        const realm = await RealmService.create(user_id, `inst-${uid()}`.slice(0, 40), 'Install Realm');
        realm_id = realm.id;

        d1 = uid();
        d2 = uid();
        for (const id of [d1, d2]) {
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
            await RealmService.upsert_daemon_member(realm_id, id);
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
        await Daemon.destroy({ where: { id: d2 } });
        await Team.destroy({ where: { id: team_id } });
        await Scope.destroy({ where: { id: scope_id } });
        await close_test_control_plane_store();
    });

    it('enqueues install for a single daemon_ids entry', async () => {
        const result = await DispatchService.install_team({
            team_id,
            daemon_ids: [d1],
            user_id,
            scope_ids: [scope_id],
            org_ids: [org_id],
        });
        expect(result.results).toHaveLength(1);
        expect(result.results[0].ok).toBe(true);
        expect(result.results[0].daemon_id).toBe(d1);
        expect(mock_enqueue).toHaveBeenCalledWith(
            d1,
            '/v1/install',
            expect.objectContaining({ team_id }),
        );
    });

    it('enqueues install for each daemon_id', async () => {
        const result = await DispatchService.install_team({
            team_id,
            daemon_ids: [d1, d2],
            user_id,
            scope_ids: [scope_id],
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
            scope_ids: [scope_id],
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
            scope_ids: [scope_id],
            org_ids: [org_id],
        })).rejects.toThrow(/daemon_ids or realm_id/);
    });

    it('rejects both daemon_ids and realm_id', async () => {
        await expect(DispatchService.install_team({
            team_id,
            daemon_ids: [d1],
            realm_id,
            user_id,
            scope_ids: [scope_id],
            org_ids: [org_id],
        })).rejects.toThrow(/not both/);
    });

    it('forbids install without scope', async () => {
        await expect(DispatchService.install_team({
            team_id,
            daemon_ids: [d1],
            user_id,
            scope_ids: [],
            org_ids: [org_id],
        })).rejects.toBeInstanceOf(ApiError);
    });
});
