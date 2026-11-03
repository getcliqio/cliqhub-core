/**
 * Slice 4 — install/uninstall via queue (audit row + per-daemon results).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { randomUUID } from 'node:crypto';

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
    DaemonTeam,
    Team,
    TeamVersion,
} from '../../src/models/index.js';
import { Scope } from '../../src/models/index.js';
import { DispatchService } from '../../src/services/dispatch.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { RealmTeamListService } from '../../src/services/realm_team_list.service.js';
import { publish_version } from './helpers/version_files.js';
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
            id: randomUUID(),
            slug: `s4-${uid()}`.slice(0, 40),
            display_name: 'slice4-scope',
            owner_id: null,
            org_id: null,
            is_default: 0,
            created_at: new Date(),
        });
        scope_id = scope.id;

        // A published catalog team on the realm's list (PLAN-team-bundle S4.2: daemons install realm teams only).
        const name = `t-${uid()}`.slice(0, 40);
        team_id = (await Team.create({
            id: randomUUID(), name, scope: scope.slug, description: 't',
            author_id: user_id, license: 'MIT', visibility: 'public', listed: 1, install_count: 0,
        } as any)).id;
        await publish_version(team_id, '1.0.0', { name: `@${scope.slug}/${name}`, phases: [] });

        const realm = await RealmService.create(user_id, `s4-${uid()}`.slice(0, 40), 'Slice4 Realm');
        realm_id = realm.id;
        await RealmTeamListService.add(realm_id, user_id, { team_id });

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
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        await RealmDispatchQueue.destroy({ where: { realm_id } });
        await RealmMember.destroy({ where: { realm_id } });
        await Realm.destroy({ where: { id: realm_id } });
        await Daemon.destroy({ where: { id: d1 } });
        await Daemon.destroy({ where: { id: d2 } });
        await DaemonTeam.unscoped().destroy({ where: { team_id } });
        await TeamVersion.destroy({ where: { team_id } });
        await Team.destroy({ where: { id: team_id } });
        await Scope.destroy({ where: { id: scope_id } });
        await close_test_control_plane_store();
    });

    it('4a install_via_queue with realm_id fans out and stores queue results', async () => {
        const result = await DispatchService.install_via_queue({
            team_id,
            realm_id,
            user_id,
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
