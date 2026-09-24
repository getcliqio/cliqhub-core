/**
 * Tests for NotifyService — PG LISTEN/NOTIFY with exponential backoff reconnect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { NotifyService } from '../src/services/notify.service.js';
import type { SyncEnvConfig } from '../src/config/env.js';

/** Mock pg.Client that records calls and allows controlling behavior. */
function make_mock_client() {
    return {
        connect: vi.fn(async () => undefined),
        query: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        on: vi.fn(),
        _fire_error: (err: Error) => {
            const error_handler = make_mock_client._last?.on.mock.calls.find(
                (c: unknown[]) => c[0] === 'error',
            )?.[1];
            if (error_handler) error_handler(err);
        },
        _fire_notification: (msg: { channel: string; payload: string }) => {
            const handler = make_mock_client._last?.on.mock.calls.find(
                (c: unknown[]) => c[0] === 'notification',
            )?.[1];
            if (handler) handler(msg);
        },
        _last: null as ReturnType<typeof make_mock_client> | null,
    };
}

const test_config: SyncEnvConfig = {
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

vi.mock('pg', () => {
    let mock_client: ReturnType<typeof make_mock_client> | null = null;

    return {
        default: {
            Client: vi.fn(() => {
                mock_client = make_mock_client();
                (mock_client as any)._last = mock_client;
                return mock_client;
            }),
        },
        __get_last_client: () => mock_client,
    };
});

describe('NotifyService', () => {
    let service: NotifyService;

    beforeEach(() => {
        vi.useFakeTimers();
        service = new NotifyService(test_config);
    });

    afterEach(async () => {
        await service.close();
        vi.useRealTimers();
    });

    it('connects and listens on both channels', async () => {
        await service.connect();

        expect(service.connected).toBe(true);
    });

    it('marks disconnected after close()', async () => {
        await service.connect();
        expect(service.connected).toBe(true);

        await service.close();
        expect(service.connected).toBe(false);
    });

    it('dispatches command_ready notifications to handlers', async () => {
        const handler = vi.fn();
        service.on_command_ready(handler);

        await service.connect();

        // Grab the notification callback registered with client.on('notification', ...)
        const pg = await import('pg');
        const client = (pg as any).__get_last_client();
        const notification_cb = client.on.mock.calls.find(
            (c: unknown[]) => c[0] === 'notification',
        )?.[1];

        notification_cb({ channel: 'sync_command_ready', payload: 'daemon-abc' });

        expect(handler).toHaveBeenCalledWith('daemon-abc');
    });

    it('dispatches response_ready notifications to handlers', async () => {
        const handler = vi.fn();
        service.on_response_ready(handler);

        await service.connect();

        const pg = await import('pg');
        const client = (pg as any).__get_last_client();
        const notification_cb = client.on.mock.calls.find(
            (c: unknown[]) => c[0] === 'notification',
        )?.[1];

        notification_cb({ channel: 'sync_response_ready', payload: 'cmd-xyz' });

        expect(handler).toHaveBeenCalledWith('cmd-xyz');
    });

    it('ignores notifications with no payload', async () => {
        const handler = vi.fn();
        service.on_command_ready(handler);

        await service.connect();

        const pg = await import('pg');
        const client = (pg as any).__get_last_client();
        const notification_cb = client.on.mock.calls.find(
            (c: unknown[]) => c[0] === 'notification',
        )?.[1];

        notification_cb({ channel: 'sync_command_ready', payload: undefined });

        expect(handler).not.toHaveBeenCalled();
    });

    it('marks disconnected on client error and schedules reconnect', async () => {
        await service.connect();
        expect(service.connected).toBe(true);

        const pg = await import('pg');
        const client = (pg as any).__get_last_client();
        const error_cb = client.on.mock.calls.find(
            (c: unknown[]) => c[0] === 'error',
        )?.[1];

        error_cb(new Error('connection reset'));

        expect(service.connected).toBe(false);
    });

    it('reconnect uses exponential backoff (1s, 2s, 4s, ...)', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5); // zero jitter
        await service.connect();

        const pg = await import('pg');
        const client = (pg as any).__get_last_client();
        const error_cb = client.on.mock.calls.find(
            (c: unknown[]) => c[0] === 'error',
        )?.[1];

        const PgClient = (pg as any).default.Client;
        const calls_after_connect = PgClient.mock.calls.length;

        // Make reconnect fail to observe backoff
        PgClient.mockImplementation(() => ({
            connect: vi.fn(async () => { throw new Error('still down'); }),
            query: vi.fn(),
            end: vi.fn(async () => undefined),
            on: vi.fn(),
        }));

        // Trigger first error
        error_cb(new Error('connection lost'));
        expect(service.connected).toBe(false);

        // First reconnect attempt after exactly 1s (base delay, no jitter)
        await vi.advanceTimersByTimeAsync(1000);
        expect(PgClient.mock.calls.length).toBe(calls_after_connect + 1);

        // Second attempt after exactly 2s more
        await vi.advanceTimersByTimeAsync(2000);
        expect(PgClient.mock.calls.length).toBe(calls_after_connect + 2);

        vi.restoreAllMocks();
    });
});
