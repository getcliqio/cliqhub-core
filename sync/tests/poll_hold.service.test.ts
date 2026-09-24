import { describe, it, expect, vi, beforeEach } from 'vitest';

import { PollHoldService } from '../src/services/poll_hold.service.js';
import type { SyncEnvConfig } from '../src/config/env.js';
import type { NotifyService } from '../src/services/notify.service.js';

/** Minimal config with short timeouts for fast tests. */
function make_config(overrides: Partial<SyncEnvConfig> = {}): SyncEnvConfig {
    return {
        port: 4901,
        database_url: 'postgres://localhost/test',
        jwt_secret: 'test-secret',
        poll_timeout_ms: 200,
        command_ttl_ms: 5000,
        client_timeout_ms: 100,
        liveness_threshold_ms: 60000,
        notify_channel: 'sync_command_ready',
        response_notify_channel: 'sync_response_ready',
        log_level: 'silent',
        node_env: 'test',
        public_url: 'http://localhost:4901',
        ...overrides,
    };
}

/** Creates a mock pg Pool. */
function make_pool(query_fn?: (...args: unknown[]) => unknown) {
    return {
        query: vi.fn(query_fn ?? (() => ({ rows: [] }))),
    };
}

/** Creates a mock NotifyService that captures handler registrations. */
function make_notify_service() {
    let command_handler: ((daemon_id: string) => void) | null = null;
    let response_handler: ((command_id: string) => void) | null = null;

    const mock: NotifyService = {
        on_command_ready: vi.fn((handler) => {
            command_handler = handler;
        }),
        on_response_ready: vi.fn((handler) => {
            response_handler = handler;
        }),
    } as unknown as NotifyService;

    return {
        mock,
        /** Simulate a pg NOTIFY for command_ready. */
        fire_command_ready: (daemon_id: string) => command_handler?.(daemon_id),
        /** Simulate a pg NOTIFY for response_ready. */
        fire_response_ready: (command_id: string) => response_handler?.(command_id),
    };
}

describe('PollHoldService', () => {
    let config: SyncEnvConfig;
    let pool: ReturnType<typeof make_pool>;
    let notify: ReturnType<typeof make_notify_service>;
    let service: PollHoldService;

    beforeEach(() => {
        config = make_config();
        pool = make_pool();
        notify = make_notify_service();
        service = new PollHoldService(config, pool as any, notify.mock);
    });

    // --- hold_poll ---

    it('hold_poll resolves empty on timeout', async () => {
        const result = await service.hold_poll('daemon-1', 50);
        expect(result).toEqual([]);
    });

    it('wake_poll resolves held poll immediately', async () => {
        const promise = service.hold_poll('daemon-1', 5000);
        service.wake_poll('daemon-1');
        const result = await promise;
        expect(result).toEqual([]);
    });

    it('release_poll resolves held poll immediately', async () => {
        const promise = service.hold_poll('daemon-1', 5000);
        service.release_poll('daemon-1');
        const result = await promise;
        expect(result).toEqual([]);
    });

    it('holding a poll replaces a previous one for the same daemon_id', async () => {
        const first_promise = service.hold_poll('daemon-1', 5000);
        const second_promise = service.hold_poll('daemon-1', 5000);

        // First poll should have been resolved (released) when the second was created
        const first_result = await first_promise;
        expect(first_result).toEqual([]);

        // Second poll is now the active one; wake it
        service.wake_poll('daemon-1');
        const second_result = await second_promise;
        expect(second_result).toEqual([]);
    });

    // --- has_active_poll ---

    it('has_active_poll returns true when poll is held', () => {
        service.hold_poll('daemon-1', 5000);
        expect(service.has_active_poll('daemon-1')).toBe(true);
    });

    it('has_active_poll returns false when no poll is held', () => {
        expect(service.has_active_poll('daemon-1')).toBe(false);
    });

    it('has_active_poll returns false after poll is woken', () => {
        service.hold_poll('daemon-1', 5000);
        service.wake_poll('daemon-1');
        expect(service.has_active_poll('daemon-1')).toBe(false);
    });

    // --- wait_for_response / resolve_waiter / reject_waiter ---

    it('wait_for_response resolves when resolve_waiter is called', async () => {
        const promise = service.wait_for_response('cmd-1');
        const response = { status_code: 200, body: { ok: true } };

        service.resolve_waiter('cmd-1', response);

        const result = await promise;
        expect(result).toEqual(response);
    });

    it('wait_for_response rejects on timeout', async () => {
        // client_timeout_ms is 100 in our test config
        const promise = service.wait_for_response('cmd-1');
        await expect(promise).rejects.toThrow('Command response timeout');
    });

    it('reject_waiter rejects the waiting promise', async () => {
        const promise = service.wait_for_response('cmd-1');
        service.reject_waiter('cmd-1', new Error('daemon offline'));
        await expect(promise).rejects.toThrow('daemon offline');
    });

    it('resolve_waiter returns false if no waiter exists', () => {
        const result = service.resolve_waiter('nonexistent-cmd', { status_code: 200 });
        expect(result).toBe(false);
    });

    // --- counters ---

    it('active_poll_count tracks held polls', () => {
        expect(service.active_poll_count).toBe(0);

        service.hold_poll('d1', 5000);
        service.hold_poll('d2', 5000);
        expect(service.active_poll_count).toBe(2);

        service.wake_poll('d1');
        expect(service.active_poll_count).toBe(1);
    });

    it('pending_waiter_count tracks pending waiters', () => {
        expect(service.pending_waiter_count).toBe(0);

        service.wait_for_response('cmd-1');
        service.wait_for_response('cmd-2');
        expect(service.pending_waiter_count).toBe(2);

        service.resolve_waiter('cmd-1', { status_code: 200 });
        expect(service.pending_waiter_count).toBe(1);
    });

    // --- notify_service integration ---

    it('on_command_ready callback wakes a local poll', async () => {
        const promise = service.hold_poll('daemon-1', 5000);
        notify.fire_command_ready('daemon-1');

        const result = await promise;
        expect(result).toEqual([]);
        expect(service.has_active_poll('daemon-1')).toBe(false);
    });

    it('on_response_ready callback calls notify_response_available', () => {
        service.wait_for_response('cmd-42');

        const spy = vi.spyOn(service, 'notify_response_available');
        notify.fire_response_ready('cmd-42');
        expect(spy).toHaveBeenCalledWith('cmd-42');
    });

    // --- reject_all_for_daemon ---

    it('reject_all_for_daemon rejects waiters for the daemon\'s commands', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ id: 'cmd-a' }, { id: 'cmd-b' }],
        });

        const promise_a = service.wait_for_response('cmd-a');
        const promise_b = service.wait_for_response('cmd-b');
        const promise_c = service.wait_for_response('cmd-c');

        await service.reject_all_for_daemon('daemon-x', new Error('daemon offline'));

        await expect(promise_a).rejects.toThrow('daemon offline');
        await expect(promise_b).rejects.toThrow('daemon offline');

        // cmd-c was not in the query results, so it should still be pending
        expect(service.pending_waiter_count).toBe(1);

        service.reject_waiter('cmd-c', new Error('cleanup'));
        await expect(promise_c).rejects.toThrow('cleanup');
    });

    it('reject_all_for_daemon queries commands by daemon_id', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        await service.reject_all_for_daemon('daemon-y', new Error('offline'));

        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('WHERE daemon_id = $1'),
            ['daemon-y'],
        );
    });

    // --- reject_all_waiters (graceful shutdown) ---

    it('reject_all_waiters rejects every pending waiter', async () => {
        const p1 = service.wait_for_response('cmd-1');
        const p2 = service.wait_for_response('cmd-2');
        const p3 = service.wait_for_response('cmd-3');

        service.reject_all_waiters(new Error('shutting down'));

        await expect(p1).rejects.toThrow('shutting down');
        await expect(p2).rejects.toThrow('shutting down');
        await expect(p3).rejects.toThrow('shutting down');
        expect(service.pending_waiter_count).toBe(0);
    });

    // --- release_all_polls (graceful shutdown) ---

    it('release_all_polls resolves all held polls with empty arrays', async () => {
        const p1 = service.hold_poll('d1', 5000);
        const p2 = service.hold_poll('d2', 5000);

        service.release_all_polls();

        expect(await p1).toEqual([]);
        expect(await p2).toEqual([]);
        expect(service.active_poll_count).toBe(0);
    });

    // --- notify_response_available (cross-instance resolution) ---

    it('notify_response_available resolves waiter from DB', async () => {
        pool.query.mockResolvedValueOnce({
            rows: [{ status_code: 201, headers: null, body: { id: 'new-team' } }],
        });

        const promise = service.wait_for_response('cmd-cross-1');
        notify.fire_response_ready('cmd-cross-1');

        // Allow async DB query to resolve
        await vi.waitFor(async () => {
            const result = await promise;
            expect(result).toEqual({
                status_code: 201,
                headers: undefined,
                body: { id: 'new-team' },
            });
        });
    });

    it('notify_response_available retries once on commit race', async () => {
        // Client timeout must exceed retry delay (200ms) so the waiter stays alive.
        config = make_config({ client_timeout_ms: 5_000 });
        service = new PollHoldService(config, pool as any, notify.mock);
        vi.useFakeTimers();

        // First query returns empty (commit race), second succeeds
        pool.query
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({
                rows: [{ status_code: 200, headers: null, body: { ok: true } }],
            });

        const promise = service.wait_for_response('cmd-cross-2');
        notify.fire_response_ready('cmd-cross-2');

        // Advance past the 200ms retry delay
        await vi.advanceTimersByTimeAsync(250);

        const result = await promise;
        expect(result).toEqual({
            status_code: 200,
            headers: undefined,
            body: { ok: true },
        });

        // Should have queried DB twice
        expect(pool.query).toHaveBeenCalledTimes(2);

        vi.useRealTimers();
    });

    it('notify_response_available does nothing if no waiter exists', () => {
        service.notify_response_available('no-such-cmd');
        expect(pool.query).not.toHaveBeenCalled();
    });
});
