import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import { EventSubmitService } from '../../src/events/submit.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import {
    close_test_control_plane_store,
    open_test_control_plane_store,
    postgres_reachable,
} from './helpers/control_plane_store.js';
import {
    ChannelDestination,
    HubEvent,
    NotificationChannel,
    NotificationRule,
    Realm,
    RealmMember,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const uid = () => `secret-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Seeded user in open_test_control_plane_store — realms require an org_id
 *  resolved from a real user row. Non-numeric strings won't resolve and
 *  the Realm.create then fails notNull. */
const test_user_id = hub_legacy_uuid(1);

beforeAll(async () => {
    if (!has_postgres) return;
    await open_test_control_plane_store();
});

beforeEach(async () => {
    if (!has_postgres) return;
    await NotificationRule.destroy({ where: {} });
    await ChannelDestination.destroy({ where: {} });
    await NotificationChannel.destroy({ where: {} });
    await HubEvent.destroy({ where: {} });
    await RealmMember.destroy({ where: {} });
    await Realm.destroy({ where: {} });
    vi.restoreAllMocks();
});

afterAll(async () => {
    if (!has_postgres) return;
    await close_test_control_plane_store();
});

function webhook_destination(url: string, secret?: string) {
    const dest: Record<string, unknown> = { type: 'webhook', url };
    if (secret !== undefined) dest.secret = secret;
    return dest;
}

function get_webhook_dest_row(channel_id: string) {
    return ChannelDestination.findOne({
        where: { channel_id, type: 'webhook' },
    });
}

describe.skipIf(!has_postgres)('notification_channels.secret column', () => {

    it('stores webhook secret in dedicated column, not in destination config JSON', async () => {
        const realm = await RealmService.create(test_user_id, `s-${uid()}`.slice(0, 40), 'Secret');
        const channel = await NotificationService.create_channel({
            realm_id: realm.id,
            name: uid(),
            destinations: [webhook_destination('https://receiver.example.com/hook', 'whsec_column_test')],
        });

        // Raw channel row: secret in the column.
        const raw = await NotificationChannel.findByPk(channel.id);
        expect(raw).not.toBeNull();
        const raw_typed = raw as unknown as { secret: string | null };
        expect(raw_typed.secret).toBe('whsec_column_test');

        // Destination row: secret should NOT be in config (it lives on the channel column).
        const dest = await get_webhook_dest_row(channel.id);
        expect(dest).not.toBeNull();
        expect((dest!.config as Record<string, unknown>).secret).toBeUndefined();
        expect((dest!.config as Record<string, unknown>).url).toBe('https://receiver.example.com/hook');
    });

    it('get_channel does not surface the raw secret in the destinations blob', async () => {
        const realm = await RealmService.create(test_user_id, `s-${uid()}`.slice(0, 40), 'Secret');
        const created = await NotificationService.create_channel({
            realm_id: realm.id,
            name: uid(),
            destinations: [webhook_destination('https://receiver.example.com/hook', 'whsec_abcdef12345')],
        });

        const fetched = await NotificationService.get_channel(created.id);
        const dests = JSON.parse(fetched.destinations) as Array<Record<string, unknown>>;
        expect(dests[0].secret).not.toBe('whsec_abcdef12345');
    });

    it('creating without secret leaves the column null', async () => {
        const realm = await RealmService.create(test_user_id, `s-${uid()}`.slice(0, 40), 'Secret');
        const channel = await NotificationService.create_channel({
            realm_id: realm.id,
            name: uid(),
            destinations: [webhook_destination('https://receiver.example.com/hook')],
        });
        const raw = await NotificationChannel.findByPk(channel.id) as unknown as { secret: string | null };
        expect(raw.secret).toBeNull();
    });

    it('fan_out injects column secret into deliverer config → webhook is signed', async () => {
        const fetch_mock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetch_mock);

        const realm = await RealmService.create(test_user_id, `s-${uid()}`.slice(0, 40), 'Secret');
        const channel = await NotificationService.create_channel({
            realm_id: realm.id,
            name: uid(),
            destinations: [webhook_destination('https://receiver.example.com/hook', 'whsec_signed_via_column')],
        });
        await NotificationService.set_rule({
            realm_id: realm.id,
            event: 'run.*',
            channel_id: channel.id,
        });

        const event = await EventSubmitService.submit({
            type: 'run.failed',
            realm_id: realm.id,
            run_id: 'run-secret-1',
            daemon_id: 'daemon-secret-1',
            message: 'boom',
        });

        expect(event.notifications).toBe('dispatched');
        expect(fetch_mock).toHaveBeenCalled();
        const [_url, init] = fetch_mock.mock.calls[0];
        const headers = (init as { headers: Record<string, string> }).headers;
        expect(headers['X-Cliq-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
        expect(headers['X-Cliq-Timestamp']).toMatch(/^\d{10}$/);
        expect(headers['X-Cliq-Event']).toBe('run.failed');
    });

    it('secret column signs the webhook payload correctly', async () => {
        const realm = await RealmService.create(test_user_id, `s-${uid()}`.slice(0, 40), 'Secret');
        const channel = await NotificationService.create_channel({
            realm_id: realm.id,
            name: uid(),
            destinations: [webhook_destination('https://receiver.example.com/legacy', 'whsec_COLUMN_wins')],
        });
        await NotificationService.set_rule({
            realm_id: realm.id,
            event: 'run.*',
            channel_id: channel.id,
        });

        const fetch_mock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetch_mock);

        await EventSubmitService.submit({
            type: 'run.failed',
            realm_id: realm.id,
            run_id: 'run-secret-2',
            daemon_id: 'daemon-secret-2',
            message: 'boom2',
        });

        const [_u, init] = fetch_mock.mock.calls[0];
        const body = (init as { body: string }).body;
        const headers = (init as { headers: Record<string, string> }).headers;
        const timestamp = headers['X-Cliq-Timestamp'];

        const { createHmac } = await import('node:crypto');
        const expected = 'sha256=' + createHmac('sha256', 'whsec_COLUMN_wins')
            .update(`${timestamp}.${body}`)
            .digest('hex');
        expect(headers['X-Cliq-Signature']).toBe(expected);
    });
});
