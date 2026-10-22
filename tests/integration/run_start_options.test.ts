/**
 * Run start options on live Postgres: the notification channel override, and the channels a run asks
 * people through (PLAN-notifications-v2 B4.2).
 *
 *   1. `runs/enqueue` refuses unknown notify channels (422 with `details.field`) before anything is queued.
 *   2. A run stores its notify channels and returns them on its record.
 *   3. The run's lifecycle events go to its own channels instead of the realm
 *      rules; other events and runs without options keep the rules.
 *   4. The channels a run asks people through — `type: channel` inputs, Hug gate reviewers, phase `hug`
 *      blocks — are read from the manifest that runs; each must be one the realm can use.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { NotificationChannel, Run, User } from '../../src/models/index.js';
import { RunService } from '../../src/services/run.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { NotificationFanOutService } from '../../src/notifications/fan_out.service.js';
import { assert_run_channels, run_channel_names } from '../../src/services/run_start_options.js';
import { to_run_data } from '../../src/lib/mappers.js';
import type { SubmittedEvent } from '../../src/services/events_service.js';

const has_postgres = await postgres_reachable();

/** A team with a channel input, a gate (one fixed name + the input) and a phase `hug` block. */
const manifest = (gate_names: string[], hug_names: string[]) => [
    'name: gated',
    'inputs:',
    '  - name: reviewers',
    '    type: channel',
    '  - name: ticket',
    'phases:',
    '  - name: design',
    '    agent: claude-code',
    `    hug: { channels: ${JSON.stringify(hug_names)} }`,
    '  - name: design-review',
    '    agent: hug',
    '    type: gate',
    '    review:',
    `      reviewers: [{ policy: any, channels: ${JSON.stringify(gate_names)} }]`,
].join('\n');

describe('run_channel_names', () => {
    it('channel inputs, gate reviewers and hug blocks — fixed names as written, input references as the input\'s value', () => {
        const names = run_channel_names(manifest(['qa', '{{inputs.reviewers}}'], ['ops', '$(inputs.reviewers)']), { reviewers: ['elan', 'priya'], ticket: 'X-1' });
        expect(names).toEqual([
            { name: 'elan', from: "input 'reviewers'" },
            { name: 'priya', from: "input 'reviewers'" },
            { name: 'ops', from: "phase 'design'" },
            { name: 'qa', from: "phase 'design-review'" },
        ]);
        expect(run_channel_names(manifest(['qa'], ['ops']), { reviewers: 'a, b' }).map((c) => c.name)).toEqual(['a', 'b', 'ops', 'qa']);
        expect(run_channel_names(manifest(['team-{{inputs.ticket}}'], ['ops']), {}).map((c) => c.name)).toEqual(['ops']);
        expect(run_channel_names(undefined, { reviewers: ['x'] })).toEqual([]);
    });
});

describe.skipIf(!has_postgres)('run start options', () => {
    let app: Express;
    let s: Seed;
    let channel_name: string;
    const run_ids: string[] = [];

    const enqueue = (body: Record<string, unknown>) => request(app).post('/v1/runs/enqueue')
        .set('Authorization', `Bearer ${s.token.olivia}`)
        .send({ realm_id: s.A1, team_id: s.team_public, ...body });

    const event = (type: string, run_id: string): SubmittedEvent => ({
        id: randomUUID(), type, occurred_at: new Date().toISOString(), realm_id: s.A1, org_id: s.acme,
        team: null, run_id, phase: null, daemon_id: null, title: null, message: null, severity: 'info',
        payload: {}, actor_id: null, created_at: Date.now(), notifications: 'deferred',
    } as SubmittedEvent);

    beforeAll(async () => {
        app = (await open_live_hub_app()).app;
        s = await seed_authz(app);
        channel_name = (await NotificationChannel.findByPk(s.channel_a1, { attributes: ['name'], raw: true }))!.name;
    }, 300_000);

    afterAll(async () => {
        await Run.destroy({ where: { run_id: run_ids } });
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    it('refuses unknown notify channels with the names', async () => {
        const channels = await enqueue({ notify_channels: ['no-such-channel'] });
        expect(channels.status, JSON.stringify(channels.body)).toBe(422);
        expect(channels.body.details).toEqual({ field: 'notify_channels', unknown: ['no-such-channel'] });
    });

    it('a run stores its options and returns them on its record', async () => {
        const run_id = await RunService.create(s.workspace_a1, s.team_public, {
            realm_id: s.A1,
            notify_channels: [channel_name],
        });
        run_ids.push(run_id);
        const row = await Run.findByPk(run_id, { raw: true });
        const data = to_run_data(row as never);
        expect(data.notify_channels).toEqual([channel_name]);
    });

    it("sends the run's lifecycle events to its channels instead of the realm rules", async () => {
        const with_options = await RunService.create(s.workspace_a1, s.team_public, { realm_id: s.A1, notify_channels: [channel_name] });
        const without = await RunService.create(s.workspace_a1, s.team_public, { realm_id: s.A1 });
        run_ids.push(with_options, without);
        const rules = vi.spyOn(NotificationService, 'resolve_rules');
        const by_name = vi.spyOn(NotificationService, 'find_channel_by_name');
        try {
            await NotificationFanOutService.notify_realm(event('run.completed', with_options));
            expect(by_name).toHaveBeenCalledWith(channel_name, s.A1);
            expect(rules).not.toHaveBeenCalled();

            await NotificationFanOutService.notify_realm(event('phase.started', with_options));
            expect(rules).toHaveBeenCalledTimes(1);

            await NotificationFanOutService.notify_realm(event('run.completed', without));
            expect(rules).toHaveBeenCalledTimes(2);
        } finally {
            rules.mockRestore();
            by_name.mockRestore();
        }
    });

    it('a run whose channels the realm can\'t use is refused, naming each one and where it comes from', async () => {
        const ok = manifest(['{{inputs.reviewers}}'], [channel_name]);
        await expect(assert_run_channels({ realm_id: s.A1, manifest_yaml: ok, inputs: { reviewers: [channel_name] } })).resolves.toBeUndefined();
        await expect(assert_run_channels({ realm_id: s.A1, manifest_yaml: manifest(['qa-nobody'], [channel_name]), inputs: { reviewers: ['nobody-in'] } }))
            .rejects.toMatchObject({
                status: 422,
                message: "Unknown channels: 'nobody-in' (input 'reviewers'), 'qa-nobody' (phase 'design-review') — not a channel this realm can use",
                details: { field: 'channels', unknown: ['nobody-in', 'qa-nobody'] },
            });
    });
    it('the run form picker: with realm_id, the realm\'s own channels too — only for a realm of that org the caller can see', async () => {
        const targets = (who: string, body: Record<string, unknown>) => request(app).post('/v1/orgs/get_reviewable_targets')
            .set('Authorization', `Bearer ${s.token[who as keyof typeof s.token]}`).send({ org_id: s.acme, ...body });
        const names = (res: request.Response) => (res.body.data.channels.items as Array<{ name: string }>).map((c) => c.name);

        const without = await targets('omar', {});
        expect(without.status, JSON.stringify(without.body)).toBe(200);
        expect(names(without)).not.toContain(channel_name);

        const with_realm = await targets('omar', { realm_id: s.A1 });
        expect(with_realm.status, JSON.stringify(with_realm.body)).toBe(200);
        expect(names(with_realm)).toContain(channel_name);

        expect((await targets('nora', { realm_id: s.A1 })).status).toBe(404);
        expect((await targets('omar', { realm_id: s.B1 })).status).toBe(404);
    });

    it('the picker: channels (with whose they are) and people, apart; a realm lists its own members; searchable; paged per group', async () => {
        const targets = (body: Record<string, unknown>) => request(app).post('/v1/orgs/get_reviewable_targets')
            .set('Authorization', `Bearer ${s.token.omar}`).send({ org_id: s.acme, ...body });
        const people = (res: request.Response) => (res.body.data.people.items as Array<{ user_id: string }>).map((p) => p.user_id);

        const in_realm = await targets({ realm_id: s.A1, limit: 100 });
        expect(in_realm.status, JSON.stringify(in_realm.body)).toBe(200);
        expect(people(in_realm)).toEqual(expect.arrayContaining([s.user.omar, s.user.mia, s.user.sam]));
        expect(people(in_realm)).not.toContain(s.user.nora);
        expect(in_realm.body.data.channels.items.find((c: { name: string }) => c.name === channel_name)).toMatchObject({ level: 'realm' });
        expect(in_realm.body.data.channels.items.every((c: { level: string }) => c.level === 'realm' || c.level === 'org')).toBe(true);

        const org_wide = await targets({ limit: 100 });
        expect(people(org_wide)).toContain(s.user.nora);

        const mia = (await User.findByPk(s.user.mia, { attributes: ['username'], raw: true }))!.username;
        const found = await targets({ realm_id: s.A1, query: mia.slice(2, 8).toUpperCase() });
        expect(people(found)).toContain(s.user.mia);

        const first = await targets({ realm_id: s.A1, kind: 'person', limit: 1 });
        const second = await targets({ realm_id: s.A1, kind: 'person', limit: 1, offset: 1 });
        expect(first.body.data.people.items).toHaveLength(1);
        expect(first.body.data.people.total).toBeGreaterThanOrEqual(3);
        expect(people(second)).not.toEqual(people(first));
        expect(first.body.data.channels).toEqual({ items: [], total: 0 });
    });
});
