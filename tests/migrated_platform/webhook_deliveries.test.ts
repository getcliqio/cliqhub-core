/**
 * Slice 1.4 — webhook_deliveries audit table.
 *
 * Contract:
 *  - One row per WebhookDeliverer.deliver() attempt attributable to a
 *    channel (context.channel_id present). v2 destination fan-out
 *    (channel_ref, ad-hoc destinations) has no owning row → no audit
 *    row (design decision documented in the deliverer).
 *  - 2xx → status_code set, error null.
 *  - Non-2xx → status_code set, error = "HTTP <code>". Does NOT throw
 *    (existing contract preserved).
 *  - Network failure (fetch throws) → status_code null, error =
 *    exception message. Deliverer RE-throws so fan_out can emit
 *    notification.failed.
 *  - Retention prunes rows older than the configured window.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hash'),
    verify_password: vi.fn().mockResolvedValue(true),
}));
import request from 'supertest';

import { create_migrated_test_app } from './helpers/test_app.js';
import {
    close_test_control_plane_store,
    open_test_control_plane_store,
    postgres_reachable,
} from './helpers/control_plane_store.js';
import { make_hub_bearer, stub_hub_pat_auth } from './helpers/hub_jwt.js';
import { EventSubmitService } from '../../src/events/submit.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import {
    WebhookDeliveryService,
    stop_webhook_delivery_retention,
} from '../../src/services/webhook_delivery.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import {
    ChannelDestination,
    HubEvent,
    NotificationChannel,
    NotificationRule,
    Realm,
    RealmMember,
    WebhookDelivery,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const { app, repos } = create_migrated_test_app();
const uid = () => `wdel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const webhook_dest = (url = 'https://receiver.example.com/hook') => [{ type: 'webhook', url }];

function mock_user(id: number, role: 'user' | 'admin' = 'admin') {
    stub_hub_pat_auth(repos);
		repos.user_repo.find_by_id.mockResolvedValue({
        id: hub_legacy_uuid(id),
        username: `user-${id}`,
        display_name: `User ${id}`,
        email: `user${id}@test.local`,
        role,
        suspended_at: null,
        suspended_reason: '',
        created_at: new Date().toISOString(),
    });
}

async function fire_event(realm_id: string) {
    await EventSubmitService.submit({
        type: 'run.failed',
        realm_id,
        run_id: `run-${uid()}`,
        daemon_id: `daemon-${uid()}`,
        message: 'boom',
    });
}

describe.skipIf(!has_postgres)('webhook_deliveries audit', () => {

    beforeAll(async () => {
        if (!has_postgres) return;
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
    });

    beforeEach(async () => {
        if (!has_postgres) return;
        await WebhookDelivery.destroy({ where: {} });
        await NotificationRule.destroy({ where: {} });
        await ChannelDestination.destroy({ where: {} });
        await NotificationChannel.destroy({ where: {} });
        await HubEvent.destroy({ where: {} });
        await RealmMember.destroy({ where: {} });
        await Realm.destroy({ where: {} });
        vi.unstubAllGlobals();
    });

    afterAll(async () => {
        if (!has_postgres) return;
        stop_webhook_delivery_retention();
        await close_test_control_plane_store();
    });

    it('records one row per 2xx delivery with status_code + response_ms', async () => {
        mock_user(1, 'admin');
        const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'W');
        await RealmMember.update({ role: 'admin' }, { where: { realm_id: realm.id, member_id: hub_legacy_uuid(1) } });

        const channel = await NotificationService.create_channel({
            realm_id: realm.id,
            name: uid(),
            destinations: webhook_dest(),
        });
        await NotificationService.set_rule({
            realm_id: realm.id,
            event: 'run.*',
            channel_id: channel.id,
        });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
        await fire_event(realm.id);

        const rows = await WebhookDelivery.findAll({ where: { channel_id: channel.id } });
        expect(rows).toHaveLength(1);
        const r = rows[0] as unknown as {
            event_type: string; url: string; status_code: number | null; response_ms: number | null; error: string | null;
        };
        expect(r.event_type).toBe('run.failed');
        expect(r.url).toBe('https://receiver.example.com/hook');
        expect(r.status_code).toBe(200);
        expect(r.response_ms).toBeGreaterThanOrEqual(0);
        expect(r.error).toBeNull();
    });

    it('records non-2xx with status_code + error, does NOT throw from deliverer', async () => {
        mock_user(1, 'admin');
        const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'W');
        await RealmMember.update({ role: 'admin' }, { where: { realm_id: realm.id, member_id: hub_legacy_uuid(1) } });

        const channel = await NotificationService.create_channel({
            realm_id: realm.id,
            name: uid(),
            destinations: webhook_dest(),
        });
        await NotificationService.set_rule({ realm_id: realm.id, event: 'run.*', channel_id: channel.id });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
        const event = await EventSubmitService.submit({
            type: 'run.failed',
            realm_id: realm.id,
            run_id: `run-${uid()}`,
            daemon_id: `daemon-${uid()}`,
            message: 'boom',
        });
        expect(event.notifications).toBe('dispatched');

        const rows = await WebhookDelivery.findAll({ where: { channel_id: channel.id } });
        expect(rows).toHaveLength(1);
        const r = rows[0] as unknown as { status_code: number | null; error: string | null };
        expect(r.status_code).toBe(503);
        expect(r.error).toBe('HTTP 503');
    });

    it('records network failure with status_code null + error message, and fan_out marks failed', async () => {
        mock_user(1, 'admin');
        const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'W');
        await RealmMember.update({ role: 'admin' }, { where: { realm_id: realm.id, member_id: hub_legacy_uuid(1) } });

        const channel = await NotificationService.create_channel({
            realm_id: realm.id,
            name: uid(),
            destinations: webhook_dest(),
        });
        await NotificationService.set_rule({ realm_id: realm.id, event: 'run.*', channel_id: channel.id });

        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
        const event = await EventSubmitService.submit({
            type: 'run.failed',
            realm_id: realm.id,
            run_id: `run-${uid()}`,
            daemon_id: `daemon-${uid()}`,
            message: 'boom',
        });
        expect(event.notifications).toBe('failed');

        const rows = await WebhookDelivery.findAll({ where: { channel_id: channel.id } });
        expect(rows).toHaveLength(1);
        const r = rows[0] as unknown as { status_code: number | null; error: string | null };
        expect(r.status_code).toBeNull();
        expect(r.error).toBe('ECONNREFUSED');
    });

    it('list_by_channel returns rows newest-first, capped by limit', async () => {
        mock_user(1, 'admin');
        const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'W');
        await RealmMember.update({ role: 'admin' }, { where: { realm_id: realm.id, member_id: hub_legacy_uuid(1) } });

        const channel = await NotificationService.create_channel({
            realm_id: realm.id,
            name: uid(),
            destinations: webhook_dest(),
        });
        await NotificationService.set_rule({ realm_id: realm.id, event: 'run.*', channel_id: channel.id });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
        for (let i = 0; i < 5; i++) {
            await fire_event(realm.id);
        }

        const listed = await WebhookDeliveryService.list_by_channel(channel.id, 3);
        expect(listed).toHaveLength(3);
        for (let i = 1; i < listed.length; i++) {
            expect(listed[i - 1].attempted_at).toBeGreaterThanOrEqual(listed[i].attempted_at);
        }
    });

    it('POST /v1/notification_channels/get_deliveries is hard-cut', async () => {
        mock_user(1, 'admin');
        const res = await request(app)
            .post('/v1/notification_channels/get_deliveries')
            .set('Authorization', make_hub_bearer({ user_id: hub_legacy_uuid(1), role: 'admin' }))
            .send({ channel_id: 'any' });
        expect(res.status).toBe(404);
    });

    it('prune_older_than deletes stale rows only', async () => {
        const fresh = { attempted_at: Date.now() };
        const stale = { attempted_at: Date.now() - 31 * 24 * 60 * 60 * 1000 };
        await WebhookDelivery.bulkCreate([
            {
                id: `wd-fresh-${uid()}`,
                channel_id: 'ch-x',
                event_type: 'run.failed',
                url: 'https://a',
                status_code: 200,
                response_ms: 5,
                attempted_at: fresh.attempted_at,
                error: null,
            },
            {
                id: `wd-stale-${uid()}`,
                channel_id: 'ch-x',
                event_type: 'run.failed',
                url: 'https://a',
                status_code: 500,
                response_ms: 20,
                attempted_at: stale.attempted_at,
                error: 'HTTP 500',
            },
        ]);

        const pruned = await WebhookDeliveryService.prune_older_than(30);
        expect(pruned).toBe(1);
        const remaining = await WebhookDelivery.findAll({ where: { channel_id: 'ch-x' } });
        expect(remaining).toHaveLength(1);
    });
});
