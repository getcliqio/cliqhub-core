import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';

import { RelayController } from '../src/controllers/relay.controller.js';
import type { PollHoldService, CommandResponse } from '../src/services/poll_hold.service.js';
import { SyncError } from '../src/middleware/error_handler.js';

vi.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

/* Shared test config matching SyncEnvConfig. */
const test_config = {
    port: 4901,
    database_url: 'postgres://localhost/test',
    jwt_secret: 'test-secret',
    poll_timeout_ms: 30000,
    command_ttl_ms: 30000,
    client_timeout_ms: 30000,
    liveness_threshold_ms: 60000,
    notify_channel: 'sync_command_ready',
    response_notify_channel: 'sync_response_ready',
    log_level: 'info',
    node_env: 'test',
    public_url: 'http://localhost:4901',
};

/** Build a minimal mock Express Request with overrides. */
const mock_req = (overrides = {}): Request => ({
    params: {},
    body: {},
    headers: {},
    daemon_auth: undefined,
    method: 'POST',
    ...overrides,
} as unknown as Request);

/** Build a mock Express Response with chainable status/json. */
const mock_res = (): Response => {
    const r = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };
    return r as unknown as Response;
};

describe('RelayController', () => {
    let pool: { query: ReturnType<typeof vi.fn> };
    let poll_hold: {
        wake_poll: ReturnType<typeof vi.fn>;
        wait_for_response: ReturnType<typeof vi.fn>;
    };
    let controller: RelayController;
    let mock_next: NextFunction;

    beforeEach(() => {
        pool = { query: vi.fn() };
        poll_hold = {
            wake_poll: vi.fn(),
            wait_for_response: vi.fn(),
        };
        mock_next = vi.fn() as NextFunction;

        controller = new RelayController(
            test_config as any,
            pool as unknown as pg.Pool,
            poll_hold as unknown as PollHoldService,
        );
    });

    it('successfully relays a command and forwards the daemon response', async () => {
        // Daemon is online
        pool.query
            .mockResolvedValueOnce({ rows: [{ status: 'online' }] })   // daemon check
            .mockResolvedValueOnce({ rows: [] })                        // insert command
            .mockResolvedValueOnce({ rows: [] });                       // pg_notify

        const daemon_response: CommandResponse = {
            status_code: 200,
            body: { result: 'ok' },
        };
        poll_hold.wait_for_response.mockResolvedValue(daemon_response);

        const req = mock_req({
            params: { daemon_id: 'daemon-1', path: 'api/v1/health' },
            method: 'GET',
            body: {},
            headers: { 'content-type': 'application/json' },
        });
        const res = mock_res();

        await controller.relay(req, res, mock_next);

        // Verify daemon status was checked
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('SELECT status FROM cliq.daemons'),
            ['daemon-1'],
        );

        // Verify command was queued with correct path
        const insert_call = pool.query.mock.calls[1];
        expect(insert_call[0]).toContain('INSERT INTO cliq.sync_command_queue');
        expect(insert_call[1][0]).toBe('test-uuid-1234');
        expect(insert_call[1][1]).toBe('daemon-1');
        expect(insert_call[1][2]).toBe('GET');
        expect(insert_call[1][3]).toBe('/api/v1/health');

        // Verify poll was woken
        expect(poll_hold.wake_poll).toHaveBeenCalledWith('daemon-1');

        // Verify pg_notify was sent
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('pg_notify'),
            ['sync_command_ready', 'daemon-1'],
        );

        // Verify response was forwarded
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ result: 'ok' });
    });

    it('returns 404 if daemon is not found in DB', async () => {
        pool.query.mockResolvedValueOnce({ rows: [] });

        const req = mock_req({
            params: { daemon_id: 'unknown-daemon', path: 'some/path' },
        });
        const res = mock_res();

        await controller.relay(req, res, mock_next);

        // SyncError(404) should be passed to next
        expect(mock_next).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 404,
                code: 'daemon_not_found',
            }),
        );
    });

    it('returns 503 if daemon status is not online', async () => {
        pool.query.mockResolvedValueOnce({ rows: [{ status: 'offline' }] });

        const req = mock_req({
            params: { daemon_id: 'daemon-1', path: 'path' },
        });
        const res = mock_res();

        await controller.relay(req, res, mock_next);

        expect(mock_next).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 503,
                code: 'daemon_offline',
            }),
        );
    });

    it('returns 503 with timeout error when wait_for_response rejects', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ status: 'online' }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        poll_hold.wait_for_response.mockRejectedValue(
            new Error('Command response timeout'),
        );

        const req = mock_req({
            params: { daemon_id: 'daemon-1', path: 'path' },
            headers: {},
        });
        const res = mock_res();

        await controller.relay(req, res, mock_next);

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith({
            ok: false,
            error: { code: 'timeout', message: 'Daemon did not respond in time' },
        });
    });

    it('extracts content-type and x-request-id headers for forwarding', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ status: 'online' }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        poll_hold.wait_for_response.mockResolvedValue({
            status_code: 200,
            body: {},
        });

        const req = mock_req({
            params: { daemon_id: 'daemon-1', path: 'action' },
            headers: {
                'content-type': 'application/json',
                'x-request-id': 'req-abc-123',
                'authorization': 'Bearer secret',
            },
        });
        const res = mock_res();

        await controller.relay(req, res, mock_next);

        // The insert call (second query) should include forwarded headers
        const insert_args = pool.query.mock.calls[1][1];
        const forwarded_headers = JSON.parse(insert_args[4]);

        expect(forwarded_headers).toEqual({
            'content-type': 'application/json',
            'x-request-id': 'req-abc-123',
        });
        // Authorization should NOT be forwarded
        expect(forwarded_headers).not.toHaveProperty('authorization');
    });

    it('uses body.tx_id as sync idempotency_key', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [{ status: 'online' }] }) // daemon check
            .mockResolvedValueOnce({ rows: [] }) // idempotency lookup: no match
            .mockResolvedValueOnce({ rows: [] }) // INSERT
            .mockResolvedValueOnce({ rows: [] }); // pg_notify
        poll_hold.wait_for_response.mockResolvedValue({
            status_code: 200,
            body: { ok: true },
        });

        const req = mock_req({
            params: { daemon_id: 'daemon-1', path: 'v1/execute' },
            headers: { 'content-type': 'application/json' },
            body: { tx_id: 'tx-aaaa', run_id: 'r1' },
        });
        const res = mock_res();

        await controller.relay(req, res, mock_next);

        const insert_call = pool.query.mock.calls.find(
            (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO cliq.sync_command_queue'),
        );
        expect(insert_call).toBeTruthy();
        const insert_args = insert_call![1] as unknown[];
        expect(insert_args[8]).toBe('tx-aaaa');
        expect(JSON.parse(insert_args[5] as string)).toEqual({ tx_id: 'tx-aaaa', run_id: 'r1' });
    });

    it('passes unexpected errors to next()', async () => {
        const db_error = new Error('connection refused');
        pool.query.mockRejectedValueOnce(db_error);

        const req = mock_req({
            params: { daemon_id: 'daemon-1', path: 'path' },
        });
        const res = mock_res();

        await controller.relay(req, res, mock_next);

        expect(mock_next).toHaveBeenCalledWith(db_error);
    });

    // ── body.tx_id idempotency ───────────────────────────────────────

    describe('idempotency', () => {
        it('returns cached response when body.tx_id matches a completed command', async () => {
            pool.query
                .mockResolvedValueOnce({ rows: [{ status: 'online' }] })         // daemon check
                .mockResolvedValueOnce({ rows: [{ id: 'existing-cmd', status: 'completed' }] }) // idempotency lookup
                .mockResolvedValueOnce({ rows: [{ status_code: 200, body: { cached: true } }] }); // response lookup

            const req = mock_req({
                params: { daemon_id: 'daemon-1', path: 'action' },
                body: { tx_id: 'idem-key-1' },
            });
            const res = mock_res();

            await controller.relay(req, res, mock_next);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ cached: true });

            // Should NOT have woken the poll or inserted a new command
            expect(poll_hold.wake_poll).not.toHaveBeenCalled();
        });

        it('attaches to existing waiter when body.tx_id matches in-flight command', async () => {
            pool.query
                .mockResolvedValueOnce({ rows: [{ status: 'online' }] })         // daemon check
                .mockResolvedValueOnce({ rows: [{ id: 'inflight-cmd', status: 'pending' }] }); // idempotency lookup

            poll_hold.wait_for_response.mockResolvedValue({
                status_code: 201,
                body: { result: 'created' },
            });

            const req = mock_req({
                params: { daemon_id: 'daemon-1', path: 'action' },
                body: { tx_id: 'idem-key-2' },
            });
            const res = mock_res();

            await controller.relay(req, res, mock_next);

            // Should wait for existing command, not create a new one
            expect(poll_hold.wait_for_response).toHaveBeenCalledWith('inflight-cmd');
            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith({ result: 'created' });
        });

        it('returns 503 when body.tx_id matches a failed command', async () => {
            pool.query
                .mockResolvedValueOnce({ rows: [{ status: 'online' }] })         // daemon check
                .mockResolvedValueOnce({ rows: [{ id: 'failed-cmd', status: 'failed' }] }); // idempotency lookup

            const req = mock_req({
                params: { daemon_id: 'daemon-1', path: 'action' },
                body: { tx_id: 'idem-key-3' },
            });
            const res = mock_res();

            await controller.relay(req, res, mock_next);

            expect(mock_next).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 503,
                    code: 'command_failed',
                }),
            );
        });

        it('queues new command when no existing match for body.tx_id', async () => {
            pool.query
                .mockResolvedValueOnce({ rows: [{ status: 'online' }] })   // daemon check
                .mockResolvedValueOnce({ rows: [] })                        // idempotency lookup: no match
                .mockResolvedValueOnce({ rows: [] })                        // INSERT command
                .mockResolvedValueOnce({ rows: [] });                       // pg_notify

            poll_hold.wait_for_response.mockResolvedValue({
                status_code: 200,
                body: { ok: true },
            });

            const req = mock_req({
                params: { daemon_id: 'daemon-1', path: 'action' },
                body: { tx_id: 'idem-key-new' },
            });
            const res = mock_res();

            await controller.relay(req, res, mock_next);

            // Should have inserted with idempotency_key
            const insert_call = pool.query.mock.calls[2];
            expect(insert_call[0]).toContain('INSERT INTO cliq.sync_command_queue');
            expect(insert_call[1][8]).toBe('idem-key-new');

            expect(res.status).toHaveBeenCalledWith(200);
        });

        it('queues without idempotency check when no tx_id in body', async () => {
            pool.query
                .mockResolvedValueOnce({ rows: [{ status: 'online' }] })   // daemon check
                .mockResolvedValueOnce({ rows: [] })                        // INSERT command
                .mockResolvedValueOnce({ rows: [] });                       // pg_notify

            poll_hold.wait_for_response.mockResolvedValue({
                status_code: 200,
                body: {},
            });

            const req = mock_req({
                params: { daemon_id: 'daemon-1', path: 'action' },
                headers: {},
            });
            const res = mock_res();

            await controller.relay(req, res, mock_next);

            // Second call is INSERT (no idempotency lookup)
            const insert_call = pool.query.mock.calls[1];
            expect(insert_call[0]).toContain('INSERT INTO cliq.sync_command_queue');
            expect(insert_call[1][8]).toBeNull(); // idempotency_key is null
        });

        it('treats body.tx_id as globally unique across daemons', async () => {
            pool.query
                .mockResolvedValueOnce({ rows: [{ status: 'online' }] })
                .mockResolvedValueOnce({
                    rows: [{ id: 'cmd-on-daemon-a', status: 'completed', daemon_id: 'daemon-a' }],
                })
                .mockResolvedValueOnce({
                    rows: [{ status_code: 200, body: { accepted: true, from: 'daemon-a' } }],
                });

            const req = mock_req({
                params: { daemon_id: 'daemon-b', path: 'v1/execute' },
                body: { tx_id: 'global-tx-1', run_id: 'run-1' },
            });
            const res = mock_res();

            await controller.relay(req, res, mock_next);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ accepted: true, from: 'daemon-a' });
            expect(poll_hold.wake_poll).not.toHaveBeenCalled();
            const insert = pool.query.mock.calls.find(
                (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO'),
            );
            expect(insert).toBeUndefined();
        });
    });

    // ── get_command_status ────────────────────────────────────────────

    describe('get_command_status', () => {
        it('returns command status from DB', async () => {
            pool.query.mockResolvedValueOnce({
                rows: [{ status: 'delivered', delivery_count: 1, created_at: '1723752000000' }],
            });

            const req = mock_req({ params: { command_id: 'cmd-status-1' } });
            const res = mock_res();

            await controller.get_command_status(req, res, mock_next);

            expect(res.json).toHaveBeenCalledWith({
                status: 'delivered',
                delivery_count: 1,
                created_at: '1723752000000',
            });
        });

        it('returns 404 when command not found', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] });

            const req = mock_req({ params: { command_id: 'no-such-cmd' } });
            const res = mock_res();

            await controller.get_command_status(req, res, mock_next);

            expect(mock_next).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 404,
                    code: 'not_found',
                }),
            );
        });
    });
});
