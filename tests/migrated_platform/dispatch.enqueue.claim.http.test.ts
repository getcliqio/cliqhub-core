/**
 * Slice 2 — Hub HTTP enqueue + claim race (session auth).
 * Proves enqueue → two concurrent claims → exactly one 200 / one 409.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Op } from 'sequelize';

import { postgres_reachable } from './helpers/control_plane_store.js';
import {
    close_live_hub_app,
    open_live_hub_app,
} from './helpers/live_hub_app.js';
import { User } from '../../src/db/models/index.js';
import {
    Realm,
    RealmMember,
    RealmDispatchQueue,
} from '../../src/models/index.js';
import { QueueService } from '../../src/services/queue.service.js';

const has_postgres = await postgres_reachable();
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const password = 'password123';

type Session = {
    username: string;
    token: string;
    user_id: string;
    default_realm_id: string;
};

function bearer(token: string): string {
    return `Bearer ${token}`;
}

async function cleanup_username(username: string): Promise<void> {
    const users = await User.findAll({
        where: { username },
        attributes: ['id', 'default_realm_id'],
    });
    if (users.length === 0) return;
    const user_ids = users.map((u) => String(u.id));
    const numeric_ids = users.map((u) => u.id);
    const realm_ids = new Set<string>();
    for (const u of users) {
        if (u.default_realm_id) realm_ids.add(u.default_realm_id);
    }
    const owned = await Realm.findAll({
        where: { owner_user_id: { [Op.in]: user_ids } },
        attributes: ['id'],
    });
    for (const r of owned) realm_ids.add(r.id);

    await User.update(
        { default_realm_id: null },
        { where: { id: { [Op.in]: numeric_ids } } },
    );

    for (const realm_id of realm_ids) {
        await RealmDispatchQueue.destroy({ where: { realm_id } });
        await RealmMember.destroy({ where: { realm_id } });
        await Realm.destroy({ where: { id: realm_id } });
    }
    // User may own Hub scopes; leave the row — realm/queue rows are the test surface.
}

describe.skipIf(!has_postgres)('dispatch enqueue + claim HTTP (Slice 2)', () => {
    let app: Express;
    let session: Session;
    const username = `q2user${stamp}`.slice(0, 32).toLowerCase();

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        const live = await open_live_hub_app();
        app = live.app;

        const account_slug = `${username}co`.slice(0, 40);
        const res = await request(app)
            .post('/internal/auth/signup')
            .send({
                username,
                email: `${username}@e2e.test`,
                password,
                account_slug,
            });
        expect(res.status).toBe(200);
        session = {
            username,
            token: res.body.data.token as string,
            user_id: res.body.data.user.id as number,
            default_realm_id: res.body.data.default_realm_id as string,
        };
    }, 300_000);

    afterAll(async () => {
        await cleanup_username(username);
        await close_live_hub_app();
    }, 300_000);

    // `/v1/runs/enqueue` with `kind: 'run'` now offers to online daemons
    // as part of the enqueue call — it will fail the request when the realm
    // has no daemons, which is the fresh-signup state used by these tests.
    // Seed the queue row via QueueService and exercise claim concurrency
    // via `/v1/runs/claim` (queue/get_by_id was hard-cut; assert via QueueService).

    it('2a/2c queued run is readable via QueueService after create', async () => {
        const item = await QueueService.create({
            realm_id: session.default_realm_id,
            kind: 'run',
            payload: { team_id: 'demo/team', workspace_id: 'ws-1' },
            submitted_by: String(session.user_id),
            status: 'queued',
        });
        expect(item.status).toBe('queued');
        expect(item.claimed_by).toBeNull();

        const got = await QueueService.get(item.id);
        expect(got?.id).toBe(item.id);
        expect(got?.status).toBe('queued');
    });

    it('2d concurrent claim via HTTP: one 200, one 409', async () => {
        const item = await QueueService.create({
            realm_id: session.default_realm_id,
            kind: 'run',
            payload: { team_id: 'demo/team' },
            submitted_by: String(session.user_id),
            status: 'queued',
        });
        const queue_item_id = item.id;

        const [a, b] = await Promise.all([
            request(app)
                .post('/v1/runs/claim')
                .set('Authorization', bearer(session.token))
                .send({ queue_item_id, daemon_id: 'daemon-http-a' }),
            request(app)
                .post('/v1/runs/claim')
                .set('Authorization', bearer(session.token))
                .send({ queue_item_id, daemon_id: 'daemon-http-b' }),
        ]);

        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([200, 409]);

        const winner = a.status === 200 ? a : b;
        expect(winner.body.ok).toBe(true);
        expect(winner.body.item.status).toBe('claimed');
        expect(['daemon-http-a', 'daemon-http-b']).toContain(winner.body.item.claimed_by);

        const got = await QueueService.get(queue_item_id);
        expect(got?.claimed_by).toBe(winner.body.item.claimed_by);
    });

    it('2e install without team_id fails via /teams/install', async () => {
        const enq = await request(app)
            .post('/v1/teams/install')
            .set('Authorization', bearer(session.token))
            .send({
                realm_id: session.default_realm_id,
            });
        expect(enq.status).toBe(400);
    });
});
