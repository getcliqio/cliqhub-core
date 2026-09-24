import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import {
    close_test_control_plane_store,
    open_test_control_plane_store,
    postgres_reachable,
} from './helpers/control_plane_store.js';
import { ApiError } from '../../src/lib/api_error.js';
import { RealmDispatchQueue } from '../../src/models/index.js';
import { QueueService } from '../../src/services/queue.service.js';

const has_postgres = await postgres_reachable();

const realm_id = 'realm-queue-test';
const daemon_a = 'daemon-a';
const daemon_b = 'daemon-b';

async function cleanup(): Promise<void> {
    await RealmDispatchQueue.destroy({ where: { realm_id } });
}

beforeAll(async () => {
    if (!has_postgres) return;
    process.env.CLIQ_BFF_LOG_LEVEL = 'error';
    await open_test_control_plane_store();
});

beforeEach(async () => {
    if (!has_postgres) return;
    await cleanup();
});

afterAll(async () => {
    if (!has_postgres) return;
    await cleanup();
    await close_test_control_plane_store();
});

describe.skipIf(!has_postgres)('QueueService (Slice 1)', () => {
    it('1b create + get returns the queued item', async () => {
        const created = await QueueService.create({
            realm_id,
            kind: 'run',
            payload: { team_id: 'team-1' },
            submitted_by: '1',
        });
        expect(created.status).toBe('queued');
        expect(created.claimed_by).toBeNull();
        expect(created.payload).toEqual({ team_id: 'team-1' });

        const loaded = await QueueService.get(created.id);
        expect(loaded.id).toBe(created.id);
        expect(loaded.realm_id).toBe(realm_id);
    });

    it('1b list_for_realm orders by priority then created_at', async () => {
        const low = await QueueService.create({
            realm_id,
            kind: 'run',
            priority: 0,
            submitted_by: '1',
            payload: { n: 1 },
        });
        const high = await QueueService.create({
            realm_id,
            kind: 'run',
            priority: 10,
            submitted_by: '1',
            payload: { n: 2 },
        });
        const list = await QueueService.list_for_realm(realm_id);
        expect(list.map((r) => r.id)).toEqual([high.id, low.id]);
    });

    it('1d sequential claim: first wins, second conflicts', async () => {
        const item = await QueueService.create({
            realm_id,
            kind: 'run',
            submitted_by: '1',
        });

        const won = await QueueService.claim(item.id, daemon_a);
        expect(won.status).toBe('claimed');
        expect(won.claimed_by).toBe(daemon_a);
        expect(won.claimed_at).toBeTypeOf('number');

        await expect(QueueService.claim(item.id, daemon_b)).rejects.toMatchObject({
            status_code: 409,
        } satisfies Partial<ApiError>);

        const again = await QueueService.get(item.id);
        expect(again.claimed_by).toBe(daemon_a);
    });

    it('1e concurrent claim from two daemons: exactly one winner', async () => {
        const item = await QueueService.create({
            realm_id,
            kind: 'run',
            submitted_by: '1',
            status: 'offered',
        });

        const results = await Promise.allSettled([
            QueueService.claim(item.id, daemon_a),
            QueueService.claim(item.id, daemon_b),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof QueueService.claim>>>).value;
        expect(['daemon-a', 'daemon-b']).toContain(winner.claimed_by);
        expect(winner.status).toBe('claimed');

        const loser_err = (rejected[0] as PromiseRejectedResult).reason;
        expect(loser_err).toBeInstanceOf(ApiError);
        expect((loser_err as ApiError).status_code).toBe(409);

        const final = await QueueService.get(item.id);
        expect(final.claimed_by).toBe(winner.claimed_by);
    });
});
