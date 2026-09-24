import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import { Daemon, Realm, RealmMember } from '../../src/models/index.js';
import {
    DaemonService,
    normalize_public_url,
} from '../../src/services/daemon.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import {
    close_test_control_plane_store,
    open_test_control_plane_store,
    postgres_reachable,
} from './helpers/control_plane_store.js';

const has_postgres = await postgres_reachable();
const user_id = hub_legacy_uuid(1);
const unique_id = () => `daemon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('DaemonService', () => {
    const daemon_ids: string[] = [];
    const other_realm_ids: string[] = [];
    let realm_id = '';

    beforeAll(async () => {
        await open_test_control_plane_store();
        realm_id = (await RealmService.create(
            user_id,
            unique_id().slice(0, 40),
            'Daemon Service',
        )).id;
    });

    afterAll(async () => {
        await RealmMember.destroy({
            where: { member_type: 'daemon', member_id: daemon_ids },
        });
        await Daemon.destroy({ where: { id: daemon_ids } });
        await RealmMember.destroy({ where: { realm_id } });
        await Realm.destroy({ where: { id: realm_id } });
        for (const id of other_realm_ids) {
            await RealmMember.destroy({ where: { realm_id: id } });
            await Realm.destroy({ where: { id } });
        }
        await close_test_control_plane_store();
    });

    it('normalizes trailing slashes from public URLs', () => {
        expect(normalize_public_url('  https://pool.example.com/// ')).toBe(
            'https://pool.example.com',
        );
    });

    it('registers and refreshes a daemon in its realm', async () => {
        const daemon_id = unique_id();
        daemon_ids.push(daemon_id);
        const first = await DaemonService.register('daemon-api-key', {
            user_id,
            user_email: 'platform@test.local',
            realm_id,
            daemon_id,
            hostname: 'worker-a',
            ip: '10.0.0.1',
            port: 4900,
        });

        expect(first.daemon_id).toBe(daemon_id);
        expect(first.realm_id).toBe(realm_id);
        expect(first.dispatch_public_key).toContain('BEGIN PUBLIC KEY');

        const refreshed = await DaemonService.register('daemon-api-key', {
            user_id,
            user_email: 'platform@test.local',
            realm_id,
            daemon_id,
            hostname: 'worker-b',
            ip: '10.0.0.2',
            port: 4901,
        });

        expect(refreshed.daemon_id).toBe(daemon_id);
        expect(refreshed.ip).toBe('10.0.0.2');
        expect(await RealmService.list_daemon_ids_in_realm(realm_id)).toContain(daemon_id);
    });

    it('moves daemon membership when re-registering into a different realm', async () => {
        const other_realm = await RealmService.create(
            user_id,
            unique_id().slice(0, 40),
            'Other Realm',
        );
        other_realm_ids.push(other_realm.id);

        const daemon_id = unique_id();
        daemon_ids.push(daemon_id);
        await DaemonService.register('daemon-api-key', {
            user_id,
            user_email: 'platform@test.local',
            realm_id,
            daemon_id,
            hostname: 'mover',
        });
        expect(await RealmService.list_daemon_ids_in_realm(realm_id)).toContain(daemon_id);

        const moved = await DaemonService.register('daemon-api-key', {
            user_id,
            user_email: 'platform@test.local',
            realm_id: other_realm.id,
            daemon_id,
            hostname: 'mover',
            permissions: {
                domains: { realms: [other_realm.id] },
                access: { daemons: ['read', 'write'] },
            },
        });

        expect(moved.realm_id).toBe(other_realm.id);
        expect(await RealmService.list_daemon_ids_in_realm(other_realm.id)).toContain(daemon_id);
        expect(await RealmService.list_daemon_ids_in_realm(realm_id)).not.toContain(daemon_id);

        const info = await DaemonService.get(daemon_id);
        const realms = (info?.permissions as { domains?: { realms?: string[] } } | undefined)
            ?.domains?.realms ?? [];
        expect(realms).toEqual([other_realm.id]);
    });

    it('honors sticky daemon_id even when public_url matches a stale row', async () => {
        // Seed a "zombie" daemon on shared public_url (e.g. a previous
        // laptop that once registered as http://127.0.0.1:4900).
        const zombie_id = unique_id();
        daemon_ids.push(zombie_id);
        await DaemonService.register('daemon-api-key', {
            user_id,
            user_email: 'platform@test.local',
            realm_id,
            daemon_id: zombie_id,
            hostname: 'zombie',
            public_url: 'http://127.0.0.1:4900',
        });

        // New daemon boots with its OWN sticky id and the same public_url —
        // must NOT get coalesced into the zombie row.
        const sticky_id = unique_id();
        daemon_ids.push(sticky_id);
        const result = await DaemonService.register('daemon-api-key', {
            user_id,
            user_email: 'platform@test.local',
            realm_id,
            daemon_id: sticky_id,
            hostname: 'fresh-laptop',
            public_url: 'http://127.0.0.1:4900',
        });

        expect(result.daemon_id).toBe(sticky_id);
        // Zombie row must still exist and still own its id.
        expect((await DaemonService.get(zombie_id))?.id).toBe(zombie_id);
    });

    it('updates heartbeat and marks a daemon offline', async () => {
        const daemon_id = unique_id();
        daemon_ids.push(daemon_id);
        await DaemonService.register('daemon-api-key', {
            user_id,
            user_email: 'platform@test.local',
            realm_id,
            daemon_id,
            hostname: 'heartbeat-worker',
        });

        await DaemonService.heartbeat(daemon_id);
        expect((await DaemonService.get(daemon_id))?.status).toBe('online');

        await DaemonService.deregister(daemon_id);
        expect((await DaemonService.get(daemon_id))?.status).toBe('offline');
    });
});
