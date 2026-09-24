/**
 * Integration tests for review chat messages and claim/unclaim.
 *
 * Uses the same migrated test app pattern as reviews_pending.test.ts:
 * real Postgres + real Sequelize, supertest for HTTP, Hub JWT for auth.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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
import { HugReviewsService } from '../../src/services/hug_reviews.service.js';
import { ReviewMessageService } from '../../src/services/review_message.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import {
    Review,
    ReviewMessage,
    ReviewNotification,
    Realm,
    RealmMember,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const { app, repos } = create_migrated_test_app();
const uid = () => `rev-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Helper: create a pending review in a fresh realm for user 1. */
async function seed_review(opts?: {
    mode?: 'verdict' | 'chat' | 'input_pause';
    initial_message?: string;
}): Promise<{ review_id: string; realm_id: string }> {
    const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'MsgTest');
    const created = await HugReviewsService.create({
        run_id: `run-${uid()}`,
        daemon_id: `daemon-${uid()}`,
        realm_id: realm.id,
        payload: { phase: 'chat-phase' },
        timeout_minutes: 60,
        actor_id: hub_legacy_uuid(1),
        mode: opts?.mode,
        initial_message: opts?.initial_message,
    });
    return { review_id: created.review_id, realm_id: realm.id };
}

describe.skipIf(!has_postgres)('Review Messages + Claim/Unclaim', () => {
    beforeAll(async () => {
		stub_hub_pat_auth(repos);
        if (!has_postgres) return;
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();

        /** Mock returns different users depending on the ID requested. */
        repos.user_repo.find_by_id.mockImplementation((id: string | number) => {
            const key = String(id);
            const user_1 = {
                id: hub_legacy_uuid(1),
                username: 'migrated-platform-user',
                display_name: 'Migrated Platform User',
                email: 'platform@test.local',
                role: 'user',
                suspended_at: null,
                suspended_reason: '',
                created_at: new Date().toISOString(),
            };
            const user_2 = {
                id: hub_legacy_uuid(2),
                username: 'migrated-platform-user-2',
                display_name: 'Migrated Platform User 2',
                email: 'platform2@test.local',
                role: 'user',
                suspended_at: null,
                suspended_reason: '',
                created_at: new Date().toISOString(),
            };
            const users: Record<string, unknown> = {
                [hub_legacy_uuid(1)]: user_1,
                [hub_legacy_uuid(2)]: user_2,
                '1': user_1,
                '2': user_2,
            };
            return Promise.resolve(users[key] ?? user_1);
        });
    });

    beforeEach(async () => {
        if (!has_postgres) return;
        await ReviewMessage.destroy({ where: {} });
        await ReviewNotification.destroy({ where: {} });
        await Review.destroy({ where: {} });
        await RealmMember.destroy({ where: {} });
        await Realm.destroy({ where: {} });
    });

    afterAll(async () => {
        if (!has_postgres) return;
        await ReviewMessage.destroy({ where: {} });
        await ReviewNotification.destroy({ where: {} });
        await Review.destroy({ where: {} });
        await close_test_control_plane_store();
    });

    // ── Messages ────────────────────────────────────────────────────

    it('send_message requires auth', async () => {
        const res = await request(app)
            .post('/v1/reviews/send_message')
            .send({ review_id: 'x', text: 'hello' });
        expect(res.status).toBe(401);
    });

    it('send_message stores and returns user message', async () => {
        const { review_id } = await seed_review({ mode: 'chat' });

        const res = await request(app)
            .post('/v1/reviews/send_message')
            .set('Authorization', make_hub_bearer())
            .send({ review_id, text: 'What about option B?' });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.role).toBe('user');
        expect(res.body.data.text).toBe('What about option B?');
        expect(res.body.data.sender_id).toBe(hub_legacy_uuid(1));
    });

    it('send_message rejects when review is decided', async () => {
        const { review_id } = await seed_review({ mode: 'chat' });

        /** Find the broadcast notification row and decide the review properly. */
        const notif = await ReviewNotification.findOne({
            where: { review_id },
        });

        await HugReviewsService.submit_verdict({
            review_id,
            action: 'PASS',
            actor_id: hub_legacy_uuid(1),
            notification_id: notif?.id,
            responded_by: hub_legacy_uuid(1),
        });

        const res = await request(app)
            .post('/v1/reviews/send_message')
            .set('Authorization', make_hub_bearer())
            .send({ review_id, text: 'too late' });

        expect(res.status).toBe(409);
    });

    it('send_agent_message stores assistant message', async () => {
        const realm = await RealmService.create(hub_legacy_uuid(1), `r-${uid()}`.slice(0, 40), 'AgentMsg');
        const daemon_id = `d-${uid()}`;
        const created = await HugReviewsService.create({
            run_id: `run-${uid()}`,
            daemon_id,
            realm_id: realm.id,
            payload: { phase: 'chat-phase' },
            timeout_minutes: 60,
            mode: 'chat',
        });

        const msg = await ReviewMessageService.send_agent_message(
            created.review_id, daemon_id, 'I found three options.',
        );

        expect(msg.role).toBe('assistant');
        expect(msg.text).toBe('I found three options.');
        expect(msg.sender_id).toBeNull();
    });

    it('send_agent_message rejects daemon_id mismatch', async () => {
        const { review_id } = await seed_review({ mode: 'chat' });

        await expect(
            ReviewMessageService.send_agent_message(review_id, 'wrong-daemon', 'imposter'),
        ).rejects.toMatchObject({ status_code: 403 });
    });

    it('list_messages returns ordered history', async () => {
        const { review_id } = await seed_review({ mode: 'chat' });

        /** Seed 3 messages with staggered timestamps. */
        for (let i = 0; i < 3; i++) {
            await ReviewMessage.create({
                id: `msg-${i}-${uid()}`,
                review_id,
                role: i % 2 === 0 ? 'assistant' : 'user',
                text: `Message ${i}`,
                sender_id: i % 2 === 0 ? null : hub_legacy_uuid(1),
                created_at: new Date(Date.now() + i * 1000),
            });
        }

        const res = await request(app)
            .post('/v1/reviews/get_messages')
            .set('Authorization', make_hub_bearer())
            .send({ review_id });

        expect(res.status).toBe(200);
        expect(res.body.data.messages).toHaveLength(3);
        expect(res.body.data.messages[0].text).toBe('Message 0');
        expect(res.body.data.messages[2].text).toBe('Message 2');
    });

    it('list_messages supports after_id cursor', async () => {
        const { review_id } = await seed_review({ mode: 'chat' });
        const msg_ids: string[] = [];

        for (let i = 0; i < 5; i++) {
            const id = `msg-cur-${i}-${uid()}`;
            msg_ids.push(id);
            await ReviewMessage.create({
                id,
                review_id,
                role: 'user',
                text: `Cursor msg ${i}`,
                sender_id: hub_legacy_uuid(1),
                created_at: new Date(Date.now() + i * 1000),
            });
        }

        const res = await request(app)
            .post('/v1/reviews/get_messages')
            .set('Authorization', make_hub_bearer())
            .send({ review_id, after_id: msg_ids[2] });

        expect(res.status).toBe(200);
        expect(res.body.data.messages).toHaveLength(2);
        expect(res.body.data.messages[0].text).toBe('Cursor msg 3');
        expect(res.body.data.messages[1].text).toBe('Cursor msg 4');
    });

    it('review create with mode chat stores initial message', async () => {
        const { review_id } = await seed_review({
            mode: 'chat',
            initial_message: 'Hello human, I need your help.',
        });

        const messages = await ReviewMessageService.list_messages(review_id);
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('assistant');
        expect(messages[0].text).toBe('Hello human, I need your help.');
    });

    // ── Claim (service-level; HTTP claim/unclaim endpoints hard-cut) ─

    it('claim_review succeeds for first claimer', async () => {
        const { review_id } = await seed_review({ mode: 'chat' });

        const result = await ReviewMessageService.claim_review(review_id, hub_legacy_uuid(1));
        expect(result.ok).toBe(true);
        expect(result.claimed_by).toBe(hub_legacy_uuid(1));

        const review = await Review.findByPk(review_id);
        expect(review?.claimed_by).toBe(hub_legacy_uuid(1));
    });

    it('claim_review returns conflict for second claimer', async () => {
        const { review_id } = await seed_review({ mode: 'chat' });

        await ReviewMessageService.claim_review(review_id, hub_legacy_uuid(1));
        const result = await ReviewMessageService.claim_review(review_id, hub_legacy_uuid(2));
        expect(result.ok).toBe(false);
        expect(result.claimed_by).toBe(hub_legacy_uuid(1));
    });

    it('claim_review is idempotent for same user', async () => {
        const { review_id } = await seed_review({ mode: 'chat' });

        await ReviewMessageService.claim_review(review_id, hub_legacy_uuid(1));
        const result = await ReviewMessageService.claim_review(review_id, hub_legacy_uuid(1));
        expect(result.ok).toBe(true);
    });

    it('unclaim_review succeeds for the claimer', async () => {
        const { review_id } = await seed_review({ mode: 'chat' });
        await ReviewMessageService.claim_review(review_id, hub_legacy_uuid(1));

        await ReviewMessageService.unclaim_review(review_id, hub_legacy_uuid(1));

        const review = await Review.findByPk(review_id);
        expect(review?.claimed_by).toBeNull();
    });

    it('unclaim_review rejects non-claimer', async () => {
        const { review_id } = await seed_review({ mode: 'chat' });
        await ReviewMessageService.claim_review(review_id, hub_legacy_uuid(1));

        await expect(
            ReviewMessageService.unclaim_review(review_id, hub_legacy_uuid(2)),
        ).rejects.toMatchObject({ status_code: 403 });
    });

    it('send_message blocked when review claimed by another user', async () => {
        const { review_id } = await seed_review({ mode: 'chat' });

        /** User 1 claims. */
        await ReviewMessageService.claim_review(review_id, hub_legacy_uuid(1));

        /** User 2 tries to send a message. */
        stub_hub_pat_auth(repos, { user_id: hub_legacy_uuid(2), username: 'migrated-platform-user-2' });
        const res = await request(app)
            .post('/v1/reviews/send_message')
            .set('Authorization', make_hub_bearer())
            .send({ review_id, text: 'Can I jump in?' });
        stub_hub_pat_auth(repos);

        expect(res.status).toBe(403);
    });

    it('send_message auto-claims unclaimed review', async () => {
        const { review_id } = await seed_review({ mode: 'chat' });

        /** Verify unclaimed. */
        let review = await Review.findByPk(review_id);
        expect(review?.claimed_by).toBeNull();

        /** Send message — should auto-claim. */
        const res = await request(app)
            .post('/v1/reviews/send_message')
            .set('Authorization', make_hub_bearer())
            .send({ review_id, text: 'Taking over.' });

        expect(res.status).toBe(200);

        review = await Review.findByPk(review_id);
        expect(review?.claimed_by).toBe(hub_legacy_uuid(1));
    });

    it('review detail includes claimed_by and message_count', async () => {
        const { review_id } = await seed_review({
            mode: 'chat',
            initial_message: 'Agent says hi.',
        });

        await ReviewMessageService.claim_review(review_id, hub_legacy_uuid(1));

        const res = await request(app)
            .post('/v1/reviews/get_by_id')
            .set('Authorization', make_hub_bearer())
            .send({ review_id });

        expect(res.status).toBe(200);
        expect(res.body.data.claimed_by).toBe(hub_legacy_uuid(1));
        expect(res.body.data.message_count).toBe(1);
    });
});
