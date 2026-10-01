/**
 * Core API 5 — reviews route file (S9, S10, S17). Production app, default mode
 * (the reviews/ routes are always enforced).
 *
 * Who may act on a review: realm viewers read it; operators chat and give a
 * verdict; a reviewer assigned by name (user-targeted notification) may read,
 * chat and decide even without a realm membership; the review's own daemon
 * reads, posts and acks. Everyone else: 404.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { Review, ReviewMessage, ReviewNotification } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('reviews access (Core API 5)', () => {
    let app: Express;
    let s: Seed;
    const made: string[] = [];
    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        const r = request(app).post(path).send({ tx_id: randomUUID(), ...body });
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    const get = (path: string, token: string, query: Record<string, string>) =>
        request(app).get(path).query(query).set('Authorization', `Bearer ${token}`);

    /** A fresh pending review in A1 (send_message claims a review, so tests don't share one). */
    async function review_in_a1(assign_to?: string): Promise<{ id: string; notification_id?: string }> {
        const id = `azrv${randomUUID().slice(0, 8)}`;
        made.push(id);
        await Review.create({ id, run_id: s.run_a1, realm_id: s.A1, org_id: s.acme, daemon_id: s.daemon_a1, payload: {}, status: 'pending', timeout_at: new Date(Date.now() + 3_600_000) } as never);
        if (!assign_to) return { id };
        const notification_id = randomUUID();
        await ReviewNotification.create({ id: notification_id, review_id: id, group_idx: 0, channel_target: 'user', user_id: assign_to } as never);
        return { id, notification_id };
    }

    beforeAll(async () => {
        const live = await open_live_hub_app();
        app = live.app;
        s = await seed_authz(app);
    }, 300_000);

    afterAll(async () => {
        const ids = [...made, s?.review_a1].filter(Boolean);
        await ReviewMessage.destroy({ where: { review_id: ids } }).catch(() => {});
        await ReviewNotification.destroy({ where: { review_id: ids } }).catch(() => {});
        await Review.destroy({ where: { id: made } }).catch(() => {});
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    describe('S9 — reading a review', () => {
        it('another org cannot read it by passing its own org_id (was a leak)', async () => {
            const res = await post('/v1/reviews/get_by_id', s.token.ben, { review_id: s.review_a1, org_id: s.beta });
            expect(res.status).toBe(404);
        });

        it('realm viewer and org owner read it; an org member outside the realm cannot', async () => {
            expect((await post('/v1/reviews/get_by_id', s.token.mia, { review_id: s.review_a1 })).status).toBe(200);
            expect((await post('/v1/reviews/get_by_id', s.token.olivia, { review_id: s.review_a1 })).status).toBe(200);
            expect((await post('/v1/reviews/get_by_id', s.token.nora, { review_id: s.review_a1, org_id: s.acme })).status).toBe(404);
        });

        it('a reviewer assigned by name reads it without a realm membership', async () => {
            const r = await review_in_a1(s.user.nora);
            expect((await post('/v1/reviews/get_by_id', s.token.nora, { review_id: r.id })).status).toBe(200);
            expect((await post('/v1/reviews/get_messages', s.token.nora, { review_id: r.id })).status).toBe(200);
        });

        it('listing a realm you cannot see → 404', async () => {
            expect((await post('/v1/reviews/get', s.token.ben, { realm_id: s.A1 })).status).toBe(404);
        });
    });

    describe('S10 — review chat', () => {
        it('another org cannot read, stream or post', async () => {
            expect((await post('/v1/reviews/get_messages', s.token.ben, { review_id: s.review_a1 })).status).toBe(404);
            expect((await get('/v1/reviews/stream_messages', s.token.ben, { review_id: s.review_a1 })).status).toBe(404);
            expect((await post('/v1/reviews/send_message', s.token.ben, { review_id: s.review_a1, text: 'hi' })).status).toBe(404);
            expect((await post('/v1/reviews/ack', s.token.ben, { review_id: s.review_a1 })).status).toBe(404);
        });

        it('a viewer reads but cannot post; an operator posts', async () => {
            const r = await review_in_a1();
            expect((await post('/v1/reviews/get_messages', s.token.mia, { review_id: r.id })).status).toBe(200);
            expect((await post('/v1/reviews/send_message', s.token.mia, { review_id: r.id, text: 'hi' })).status).toBe(403);
            expect((await post('/v1/reviews/send_message', s.token.omar, { review_id: r.id, text: 'hi' })).status).toBe(200);
        });

        it('an assigned reviewer can post', async () => {
            const r = await review_in_a1(s.user.nora);
            expect((await post('/v1/reviews/send_message', s.token.nora, { review_id: r.id, text: 'looks good' })).status).toBe(200);
        });
    });

    describe('verdict', () => {
        it('a viewer cannot decide; the assigned reviewer can', async () => {
            const r = await review_in_a1(s.user.nora);
            expect((await post('/v1/reviews/verdict', s.token.mia, { review_id: r.id, action: 'PASS', notification_id: r.notification_id })).status).toBe(403);
            const ok = await post('/v1/reviews/verdict', s.token.nora, { review_id: r.id, action: 'PASS', notification_id: r.notification_id });
            expect(ok.status).toBe(200);
            expect((await Review.findOne({ where: { id: r.id }, raw: true }))?.status).not.toBe('pending');
        });
    });

    describe('S17 — daemon tokens', () => {
        it('a daemon of another realm cannot read or post', async () => {
            expect((await post('/v1/reviews/get_by_id', s.token.dB, { review_id: s.review_a1 })).status).toBe(404);
            expect((await post('/v1/reviews/send_message', s.token.dB, { review_id: s.review_a1, text: 'x', daemon_id: 'any' })).status).toBe(404);
        });

        it('the review’s realm daemon reads and posts as its own daemon only', async () => {
            const r = await review_in_a1();
            expect((await post('/v1/reviews/get_by_id', s.token.dA, { review_id: r.id })).status).toBe(200);
            expect((await post('/v1/reviews/send_message', s.token.dA, { review_id: r.id, text: 'agent says', daemon_id: s.daemon_a1 })).status).toBe(200);
            expect((await post('/v1/reviews/send_message', s.token.dA, { review_id: r.id, text: 'spoof', daemon_id: 'not-my-daemon' })).status).toBe(403);
        });

        it('reviews/create: only in the token’s realm, for a run of that realm', async () => {
            const body = { run_id: s.run_a1, daemon_id: s.daemon_a1, realm_id: s.A1, payload: { title: 'check' } };
            expect((await post('/v1/reviews/create', s.token.dB, body)).status).toBe(404);
            expect((await post('/v1/reviews/create', s.token.dA, { ...body, run_id: s.run_b1 })).status).toBe(404);
            expect((await post('/v1/reviews/create', s.token.dA, { ...body, daemon_id: 'not-my-daemon' })).status).toBe(403);
            const ok = await post('/v1/reviews/create', s.token.dA, body);
            expect(ok.status).toBe(201);
            made.push(String(ok.body.data.review_id ?? ok.body.data.id));
        });
    });
});
