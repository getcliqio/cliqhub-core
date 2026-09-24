import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import { EventSubmitService } from '../../src/events/submit.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import {
    ChannelDestination,
    HubEvent,
    NotificationChannel,
    NotificationRule,
    Realm,
    RealmMember,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const uid = () => `fanout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Seeded user in open_test_control_plane_store — needed for realm's
 *  org_id resolution (Realm.org_id is NOT NULL). */
const test_user_id = hub_legacy_uuid(1);

const slack_dest = (url = 'https://hooks.slack.com/services/T/B/X') => [{ type: 'slack', webhook_url: url }];

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

describe.skipIf(!has_postgres)('Notification fan-out on event submit', () => {
    it('dispatches slack deliverer for matching group rule', async () => {
        const fetch_mock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetch_mock);

        const realm = await RealmService.create(test_user_id, `f-${uid()}`.slice(0, 40), 'Fanout');
        const channel = await NotificationService.create_channel({
            realm_id: realm.id,
            name: uid(),
            destinations: slack_dest(),
        });
        await NotificationService.set_rule({
            realm_id: realm.id,
            event: 'run.*',
            channel_id: channel.id,
        });

        const event = await EventSubmitService.submit({
            type: 'run.failed',
            realm_id: realm.id,
            run_id: 'run-fanout-1',
            daemon_id: 'daemon-fanout-1',
            message: 'boom',
        });

        expect(event.notifications).toBe('dispatched');
        expect(fetch_mock).toHaveBeenCalled();
        const body = JSON.parse(fetch_mock.mock.calls[0][1].body as string) as { text: string };
        expect(body.text).toContain('boom');
    });

    it('default-notify without rules still dispatches via realm:all_users', async () => {
        const realm = await RealmService.create(test_user_id, `f-${uid()}`.slice(0, 40), 'Empty');
        await NotificationRule.destroy({ where: { realm_id: realm.id } });
        const event = await EventSubmitService.submit({
            type: 'run.failed',
            realm_id: realm.id,
            run_id: 'run-fanout-2',
            daemon_id: 'daemon-fanout-2',
        });
        expect(event.notifications).toBe('dispatched');
    });

    it('dispatches via global rules for team.* without realm_id', async () => {
        const fetch_mock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetch_mock);

        const channel = await NotificationService.create_channel({
            realm_id: null,
            org_id: hub_legacy_uuid(1),
            name: uid(),
            destinations: slack_dest(),
        });
        await NotificationService.set_rule({
            event: 'team.*',
            channel_id: channel.id,
        });

        const event = await EventSubmitService.submit({
            type: 'team.published',
            team: '@acme/demo',
            message: 'published',
        });

        expect(event.notifications).toBe('dispatched');
        expect(fetch_mock).toHaveBeenCalled();
    });

    it('skips team.* when no global rules', async () => {
        const event = await EventSubmitService.submit({
            type: 'team.published',
            team: '@acme/demo',
        });
        expect(event.notifications).toBe('skipped');
    });

    it('dispatches Slack for run.started, phase.input_required, and hug.review_requested when rules exist', async () => {
        const fetch_mock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetch_mock);

        const realm = await RealmService.create(test_user_id, `f-${uid()}`.slice(0, 40), 'DispatchNotifs');
        const channel = await NotificationService.create_channel({
            realm_id: realm.id,
            name: uid(),
            destinations: slack_dest(),
        });
        for (const sel of ['run.*', 'phase.*', 'hug.*']) {
            await NotificationService.set_rule({
                realm_id: realm.id,
                event: sel,
                channel_id: channel.id,
            });
        }

        const cases = [
            { type: 'run.started' as const, message: 'run started', phase: undefined as string | undefined },
            { type: 'phase.input_required' as const, message: 'need inputs', phase: 'collect' },
            { type: 'hug.review_requested' as const, message: 'review please', phase: undefined },
        ];

        for (const c of cases) {
            fetch_mock.mockClear();
            const event = await EventSubmitService.submit({
                type: c.type,
                realm_id: realm.id,
                run_id: `run-${c.type}`,
                daemon_id: 'daemon-dispatch-1',
                phase: c.phase,
                message: c.message,
            });
            expect(event.notifications).toBe('dispatched');
            expect(fetch_mock).toHaveBeenCalled();
            /** phase.input_required also creates an input_pause review which
             *  submits hug.review_requested — match any Slack body, not only
             *  the first call. */
            const texts = fetch_mock.mock.calls.map((call) => {
                const body = JSON.parse((call[1] as { body: string }).body) as { text: string };
                return body.text;
            });
            expect(texts.some((t) => t.includes(c.message))).toBe(true);
        }
    });
});
