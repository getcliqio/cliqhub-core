/**
 * Core API 5 — events route file (S11, S13, S19, S20) plus the realm
 * notification-admin rule shared with rules/channels. Production app, default
 * mode (events/ routes are always enforced).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { CustomEvent, HubEvent } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('events access (Core API 5)', () => {
    let app: Express;
    let s: Seed;
    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        // events/submit is dedup-wrapped and needs a tx_id.
        const r = request(app).post(path).send({ tx_id: randomUUID(), ...body });
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    const custom_type = () => `custom.az${randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
        const live = await open_live_hub_app();
        app = live.app;
        s = await seed_authz(app);
    }, 300_000);

    afterAll(async () => {
        await HubEvent.destroy({ where: { realm_id: [s.A1, s.A2, s.B1] } }).catch(() => {});
        await CustomEvent.destroy({ where: { realm_id: [s.A1, s.A2, s.B1] } }).catch(() => {});
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    describe('S11 — submitting events', () => {
        it('another org’s user or daemon cannot fire events into a realm (404)', async () => {
            expect((await post('/v1/events/submit', s.token.ben, { type: custom_type(), realm_id: s.A1 })).status).toBe(404);
            expect((await post('/v1/events/submit', s.token.dB, { type: custom_type(), realm_id: s.A1 })).status).toBe(404);
        });

        it('a viewer cannot fire events; an operator and the realm daemon can', async () => {
            expect((await post('/v1/events/submit', s.token.mia, { type: custom_type(), realm_id: s.A1 })).status).toBe(403);
            expect((await post('/v1/events/submit', s.token.omar, { type: custom_type(), realm_id: s.A1 })).status).toBe(200);
            expect((await post('/v1/events/submit', s.token.dA, { type: custom_type(), realm_id: s.A1 })).status).toBe(200);
        });

        it('an event may only name a run of its own realm, and a daemon only its own daemons', async () => {
            expect((await post('/v1/events/submit', s.token.dA, { type: custom_type(), realm_id: s.A1, run_id: s.run_b1 })).status).toBe(404);
            expect((await post('/v1/events/submit', s.token.dA, { type: custom_type(), realm_id: s.A1, daemon_id: 'not-mine' })).status).toBe(403);
        });

        it('an org-only event from a daemon must be for its realm’s org', async () => {
            expect((await post('/v1/events/submit', s.token.dA, { type: 'notification.test', org_id: s.beta })).status).toBe(403);
        });

        it('no realm and no org → 400', async () => {
            expect((await post('/v1/events/submit', s.token.omar, { type: 'notification.test' })).status).toBe(400);
        });
    });

    describe('S13 — reading one event', () => {
        it('another org → 404; a viewer reads it', async () => {
            expect((await post('/v1/events/get_by_id', s.token.ben, { id: s.event_a1 })).status).toBe(404);
            const ok = await post('/v1/events/get_by_id', s.token.mia, { id: s.event_a1 });
            expect(ok.status).toBe(200);
            expect(ok.body.event.id).toBe(s.event_a1);
        });
    });

    describe('S19 / S20 — custom event types', () => {
        it('listing without a realm is for site admins only', async () => {
            expect((await post('/v1/events/custom/list', s.token.mia, {})).status).toBe(403);
            expect((await post('/v1/events/custom/list', s.token.sam, {})).status).toBe(200);
            expect((await post('/v1/events/custom/list', s.token.mia, { realm_id: s.A1 })).status).toBe(200);
            expect((await post('/v1/events/custom/list', s.token.ben, { realm_id: s.A1 })).status).toBe(404);
        });

        it('hub-wide custom events can only be removed by a site admin', async () => {
            const id = randomUUID();
            await CustomEvent.create({ id, event_type: custom_type(), source: 'declared', realm_id: null, created_at: Date.now() } as never);
            try {
                expect((await post('/v1/events/custom/remove', s.token.adam, { id })).status).toBe(404);
                expect((await post('/v1/events/custom/remove', s.token.sam, { id })).status).toBe(200);
            } finally {
                await CustomEvent.destroy({ where: { id } });
            }
        });
    });

    describe('realm notification admin (custom events, rules, channels)', () => {
        it('operate + rules.manage.realm: operator and org admin yes, viewer no, outsider 404', async () => {
            expect((await post('/v1/events/custom/create', s.token.omar, { realm_id: s.A1, event_type: custom_type() })).status).toBe(200);
            expect((await post('/v1/events/custom/create', s.token.adam, { realm_id: s.A1, event_type: custom_type() })).status).toBe(200);
            expect((await post('/v1/events/custom/create', s.token.mia, { realm_id: s.A1, event_type: custom_type() })).status).toBe(403);
            expect((await post('/v1/events/custom/create', s.token.ben, { realm_id: s.A1, event_type: custom_type() })).status).toBe(404);
        });

        it('an org operator cannot manage rules of a realm they were never added to (was allowed by org permission alone)', async () => {
            expect((await post('/v1/events/custom/create', s.token.omar, { realm_id: s.A2, event_type: custom_type() })).status).toBe(404);
        });
    });
});
