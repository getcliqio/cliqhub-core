/**
 * Run start options on live Postgres: reviewers per human phase and the
 * notification channel override.
 *
 *   1. `runs/enqueue` refuses unknown reviewers and unknown channels (422 with
 *      `details.field`) before anything is queued.
 *   2. A run stores the options and returns them on its record.
 *   3. The run's lifecycle events go to its own channels instead of the realm
 *      rules; other events and runs without options keep the rules.
 *   4. Reviewer phases are checked against the manifest that runs.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { NotificationChannel, Run } from '../../src/models/index.js';
import { RunService } from '../../src/services/run.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { NotificationFanOutService } from '../../src/notifications/fan_out.service.js';
import { assert_reviewer_phases } from '../../src/services/run_start_options.js';
import { to_run_data } from '../../src/lib/mappers.js';
import type { SubmittedEvent } from '../../src/services/events_service.js';

const has_postgres = await postgres_reachable();

const MANIFEST = [
    'name: gated',
    'phases:',
    '  - name: design',
    '    agent: claude-code',
    '  - name: design-review',
    '    agent: hug',
    '    type: gate',
].join('\n');

describe('assert_reviewer_phases', () => {
    it('accepts phases the manifest has and refuses others with the unknown names', () => {
        expect(() => assert_reviewer_phases(MANIFEST, { 'design-review': ['priya'] })).not.toThrow();
        expect(() => assert_reviewer_phases(MANIFEST, { deploy: ['priya'] })).toThrow(
            expect.objectContaining({ status: 422, details: { field: 'reviewers', unknown_phases: ['deploy'] } }),
        );
        expect(() => assert_reviewer_phases(undefined, { deploy: ['priya'] })).not.toThrow();
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

    it('refuses unknown reviewers and unknown channels with the names', async () => {
        const reviewers = await enqueue({ reviewers: { 'design-review': ['nobody-here-xyz'] } });
        expect(reviewers.status, JSON.stringify(reviewers.body)).toBe(422);
        expect(reviewers.body.details).toEqual({ field: 'reviewers', unknown: ['nobody-here-xyz'] });

        const channels = await enqueue({ notify_channels: ['no-such-channel'] });
        expect(channels.status, JSON.stringify(channels.body)).toBe(422);
        expect(channels.body.details).toEqual({ field: 'notify_channels', unknown: ['no-such-channel'] });
    });

    it('a run stores its options and returns them on its record', async () => {
        const run_id = await RunService.create(s.workspace_a1, s.team_public, {
            realm_id: s.A1,
            reviewers: { 'design-review': ['olivia'] },
            notify_channels: [channel_name],
        });
        run_ids.push(run_id);
        const row = await Run.findByPk(run_id, { raw: true });
        const data = to_run_data(row as never);
        expect(data.reviewers).toEqual({ 'design-review': ['olivia'] });
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
});
