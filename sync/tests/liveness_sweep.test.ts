import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { LivenessSweep } from '../src/services/liveness_sweep.js';
import type { SyncEnvConfig } from '../src/config/env.js';
import type { PollHoldService } from '../src/services/poll_hold.service.js';

/** Minimal config for sweep tests. */
function make_config(): SyncEnvConfig {
    return {
        port: 4901,
        database_url: 'postgres://localhost/test',
        jwt_secret: 'test-secret',
        poll_timeout_ms: 30000,
        command_ttl_ms: 30000,
        client_timeout_ms: 30000,
        liveness_threshold_ms: 60000,
        notify_channel: 'sync_command_ready',
        response_notify_channel: 'sync_response_ready',
        log_level: 'silent',
        node_env: 'test',
        public_url: 'http://localhost:4901',
    };
}

/** Creates a mock pg Pool with a controllable query function. */
function make_pool(query_fn?: (...args: unknown[]) => unknown) {
    return {
        query: vi.fn(query_fn ?? (() => ({ rows: [] }))),
    };
}

/** Creates a mock PollHoldService. */
function make_poll_hold() {
    return {
        reject_waiter: vi.fn(),
        reject_all_for_daemon: vi.fn(async () => undefined),
    };
}

describe('LivenessSweep', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('start() creates an interval and stop() clears it', () => {
        const config = make_config();
        const pool = make_pool();
        const poll_hold = make_poll_hold();
        const sweep = new LivenessSweep(
            config,
            pool as any,
            poll_hold as unknown as PollHoldService,
        );

        sweep.start();

        // Pool should not have been called yet (first sweep fires after 15s)
        expect(pool.query).not.toHaveBeenCalled();

        // Advance 15s — sweep fires
        vi.advanceTimersByTime(15_000);
        expect(pool.query).toHaveBeenCalled();

        sweep.stop();

        // After stop, no more calls
        const call_count = pool.query.mock.calls.length;
        vi.advanceTimersByTime(30_000);
        expect(pool.query.mock.calls.length).toBe(call_count);
    });

    it('sweep marks daemons offline whose last_heartbeat_ms < threshold', async () => {
        const config = make_config();
        const pool = make_pool(() => ({ rows: [] }));
        const poll_hold = make_poll_hold();
        const sweep = new LivenessSweep(
            config,
            pool as any,
            poll_hold as unknown as PollHoldService,
        );

        sweep.start();
        await vi.advanceTimersByTimeAsync(15_000);

        const first_call = pool.query.mock.calls[0];
        expect(first_call[0]).toContain('UPDATE cliq.daemons');
        expect(first_call[0]).toContain("SET status = 'offline'");
        expect(first_call[0]).toContain('RETURNING id');

        const threshold_param = first_call[1][0];
        expect(typeof threshold_param).toBe('number');

        sweep.stop();
    });

    it('sweep requeues delivered commands when daemon goes offline (retries remaining)', async () => {
        const config = make_config();
        const query_results: Array<{ rows: unknown[] }> = [];

        // 1: offline daemons RETURNING id
        query_results.push({ rows: [{ id: 'daemon-1' }] });
        // 2: requeue delivered -> pending (for daemon-1)
        query_results.push({ rows: [] });
        // 3: failed transition (for daemon-1)
        query_results.push({ rows: [] });
        // 4: expire commands
        query_results.push({ rows: [] });

        let call_idx = 0;
        const pool = make_pool(() => query_results[call_idx++] ?? { rows: [] });
        const poll_hold = make_poll_hold();
        const sweep = new LivenessSweep(
            config,
            pool as any,
            poll_hold as unknown as PollHoldService,
        );

        sweep.start();
        await vi.advanceTimersByTimeAsync(15_000);

        // Second query should requeue commands
        const requeue_call = pool.query.mock.calls[1];
        expect(requeue_call[0]).toContain("SET status = 'pending'");
        expect(requeue_call[0]).toContain('delivery_count < max_deliveries');
        expect(requeue_call[1][0]).toBe('daemon-1');

        sweep.stop();
    });

    it('sweep transitions to failed when delivery retries exhausted', async () => {
        const config = make_config();
        const query_results: Array<{ rows: unknown[] }> = [];

        // 1: offline daemons
        query_results.push({ rows: [{ id: 'daemon-1' }] });
        // 2: requeue (none left)
        query_results.push({ rows: [] });
        // 3: failed transition — some commands exhausted retries
        query_results.push({ rows: [{ id: 'cmd-fail-1' }, { id: 'cmd-fail-2' }] });
        // 4: expire commands
        query_results.push({ rows: [] });

        let call_idx = 0;
        const pool = make_pool(() => query_results[call_idx++] ?? { rows: [] });
        const poll_hold = make_poll_hold();
        const sweep = new LivenessSweep(
            config,
            pool as any,
            poll_hold as unknown as PollHoldService,
        );

        sweep.start();
        await vi.advanceTimersByTimeAsync(15_000);

        // Should reject waiters for failed commands
        expect(poll_hold.reject_waiter).toHaveBeenCalledWith('cmd-fail-1', expect.any(Error));
        expect(poll_hold.reject_waiter).toHaveBeenCalledWith('cmd-fail-2', expect.any(Error));

        sweep.stop();
    });

    it('sweep calls reject_all_for_daemon when daemon goes offline', async () => {
        const config = make_config();
        const query_results: Array<{ rows: unknown[] }> = [];

        query_results.push({ rows: [{ id: 'daemon-1' }, { id: 'daemon-2' }] });
        // Remaining queries return empty
        for (let i = 0; i < 10; i++) query_results.push({ rows: [] });

        let call_idx = 0;
        const pool = make_pool(() => query_results[call_idx++] ?? { rows: [] });
        const poll_hold = make_poll_hold();
        const sweep = new LivenessSweep(
            config,
            pool as any,
            poll_hold as unknown as PollHoldService,
        );

        sweep.start();
        await vi.advanceTimersByTimeAsync(15_000);

        expect(poll_hold.reject_all_for_daemon).toHaveBeenCalledWith(
            'daemon-1',
            expect.any(Error),
        );
        expect(poll_hold.reject_all_for_daemon).toHaveBeenCalledWith(
            'daemon-2',
            expect.any(Error),
        );

        sweep.stop();
    });

    it('sweep expires commands past their TTL', async () => {
        const config = make_config();
        const query_results: Array<{ rows: unknown[] }> = [];

        // 1: no offline daemons
        query_results.push({ rows: [] });
        // 2: expire commands — returns expired ids
        query_results.push({ rows: [{ id: 'cmd-exp-1' }, { id: 'cmd-exp-2' }] });

        let call_idx = 0;
        const pool = make_pool(() => query_results[call_idx++] ?? { rows: [] });
        const poll_hold = make_poll_hold();
        const sweep = new LivenessSweep(
            config,
            pool as any,
            poll_hold as unknown as PollHoldService,
        );

        sweep.start();
        await vi.advanceTimersByTimeAsync(15_000);

        expect(poll_hold.reject_waiter).toHaveBeenCalledWith('cmd-exp-1', expect.any(Error));
        expect(poll_hold.reject_waiter).toHaveBeenCalledWith('cmd-exp-2', expect.any(Error));

        sweep.stop();
    });

    it('sweep catches errors without crashing', async () => {
        const config = make_config();
        const pool = make_pool(() => {
            throw new Error('connection lost');
        });
        const poll_hold = make_poll_hold();
        const sweep = new LivenessSweep(
            config,
            pool as any,
            poll_hold as unknown as PollHoldService,
        );

        // Suppress console.error output in tests
        const console_spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        sweep.start();
        await vi.advanceTimersByTimeAsync(15_000);

        // Should have logged the error rather than crashing
        expect(console_spy).toHaveBeenCalledWith(
            '[Sync] Liveness sweep error:',
            'connection lost',
        );

        // Sweep still ticks — next interval still fires without throwing
        await vi.advanceTimersByTimeAsync(15_000);
        expect(console_spy).toHaveBeenCalledTimes(2); // 2 sweep errors (one per tick)

        sweep.stop();
        console_spy.mockRestore();
    });
});
