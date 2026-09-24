/**
 * Slice 4 — install/uninstall via queue (audit row + per-daemon results).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { Op } from 'sequelize';

import {
    close_test_control_plane_store,
    open_test_control_plane_store,
    postgres_reachable,
} from './helpers/control_plane_store.js';
import {
    Daemon,
    Realm,
    RealmMember,
    RealmDispatchQueue,
    Scope,
    Team,
} from '../../src/models/index.js';
import { DispatchService } from '../../src/services/dispatch.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import * as outbox from '../../src/services/command_outbox.service.js';

const has_postgres = await postgres_reachable();
const uid = () => `d4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('DispatchService install/uninstall via queue (Slice 4)', () => {
    const org_id = uid();
    const user_id = hub_legacy_uuid(1);
    let scope_id: string;
    let team_id: string;
    let realm_id: string;
    let d1: string;
    let d2: string;
    /** Spy on outbox enqueue — install/uninstall now goes through the durable outbox. */
    const mock_enqueue = vi.fn();

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
        mock_enqueue.mockResolvedValue({ tx_id: 'test-tx-id' });
        vi.spyOn(outbox, 'command_outbox_enqueue').mockImplementation(mock_enqueue);

        const scope = await Scope.create({
            id: uid(),
            slug: `s4-${uid()}`.slice(0, 40),
            name: 'slice4-scope',
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

        const realm = await RealmService.create(user_id, `s4-${uid()}`.slice(0, 40), 'Slice4 Realm');
        realm_id = realm.id;

        d1 = uid();
        d2 = uid();
        for (const id of [d1, d2]) {
            await Daemon.create({
                id,
                api_key_hash: 'h',
                user_id,
                user_email: 'platform@test.local',
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

    beforeEach(async () => {
        mock_enqueue.mockReset();
        mock_enqueue.mockResolvedValue({ tx_id: 'test-tx-id' });
        // Realm fan-out in earlier tests can rebind the seeded team to
        // whichever daemon Postgres returns first (order between d1/d2
        // isn't fully deterministic given equal last_heartbeats). Reset
        // the seed team to its unbound baseline so per-test assertions
        // on team_id are stable. Also clear the daemon-cloned rows that
        // fan-out may create for the "other" daemon.
        if (team_id) {
            await Team.update({ daemon_id: null }, { where: { id: team_id } });
            await Team.destroy({
                where: {
                    scope_id,
                    id: { [Op.ne]: team_id },
                    daemon_id: { [Op.in]: [d1, d2] },
                },
            });
        }
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        await RealmDispatchQueue.destroy({ where: { realm_id } });
        await RealmMember.destroy({ where: { realm_id } });
        await Realm.destroy({ where: { id: realm_id } });
        await Daemon.destroy({ where: { id: d1 } });
        await Daemon.destroy({ where: { id: d2 } });
        await Team.destroy({ where: { id: team_id } });
        await Scope.destroy({ where: { id: scope_id } });
        await close_test_control_plane_store();
    });

    it('4a install_via_queue with realm_id fans out and stores queue results', async () => {
        const result = await DispatchService.install_via_queue({
            team_id,
            realm_id,
            user_id,
            scope_ids: [scope_id],
            org_ids: [org_id],
        });

        expect(result.results).toHaveLength(2);
        expect(result.results.every((r) => r.ok)).toBe(true);
        expect(result.item.status).toBe('completed');
        expect(result.item.kind).toBe('install');
        expect(result.item.results).toEqual(result.results);
        expect(mock_enqueue).toHaveBeenCalledTimes(2);

        const row = await RealmDispatchQueue.findByPk(result.item.id);
        expect(row).toBeTruthy();
        expect(row!.status).toBe('completed');
    });

    it('4a install_via_queue with daemon_ids pins targets and audits queue', async () => {
        const result = await DispatchService.install_via_queue({
            team_id,
            daemon_ids: [d1],
            user_id,
            scope_ids: [scope_id],
            org_ids: [org_id],
        });

        expect(result.results).toHaveLength(1);
        expect(result.results[0]!.daemon_id).toBe(d1);
        expect(result.item.status).toBe('completed');
        expect(result.item.realm_id).toBe(realm_id);
        expect(mock_enqueue).toHaveBeenCalledTimes(1);
        expect(mock_enqueue).toHaveBeenCalledWith(
            d1,
            '/v1/install',
            expect.objectContaining({ team_id }),
        );
    });

    it('4b uninstall_via_queue with realm_id fans out and stores queue results', async () => {
        const result = await DispatchService.uninstall_via_queue({
            scope: 'demo',
            slug: 'hello',
            realm_id,
            user_id,
            org_ids: [org_id],
        });

        expect(result.results).toHaveLength(2);
        expect(result.results.every((r) => r.ok)).toBe(true);
        expect(result.item.status).toBe('completed');
        expect(result.item.kind).toBe('uninstall');
        expect(mock_enqueue).toHaveBeenCalledTimes(2);
        expect(mock_enqueue).toHaveBeenCalledWith(
            d1,
            '/v1/uninstall',
            expect.objectContaining({ scope: 'demo', slug: 'hello' }),
        );
    });

    it('4b uninstall_via_queue with single daemon_id stays compatible', async () => {
        const result = await DispatchService.uninstall_via_queue({
            scope: 'demo',
            slug: 'hello',
            daemon_ids: [d2],
            user_id,
            org_ids: [org_id],
        });

        expect(result.results).toHaveLength(1);
        expect(result.results[0]!.daemon_id).toBe(d2);
        expect(result.item.status).toBe('completed');
        expect(mock_enqueue).toHaveBeenCalledTimes(1);
    });
});
