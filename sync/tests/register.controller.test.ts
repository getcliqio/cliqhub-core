import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';

import { RegisterController } from '../src/controllers/register.controller.js';
import type { PollHoldService } from '../src/services/poll_hold.service.js';

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

describe('RegisterController', () => {
    let pool: { query: ReturnType<typeof vi.fn> };
    let poll_hold: {
        reject_waiter: ReturnType<typeof vi.fn>;
        reject_all_for_daemon: ReturnType<typeof vi.fn>;
        release_poll: ReturnType<typeof vi.fn>;
    };
    let controller: RegisterController;
    let mock_next: NextFunction;

    beforeEach(() => {
        pool = { query: vi.fn() };
        poll_hold = {
            reject_waiter: vi.fn(),
            reject_all_for_daemon: vi.fn().mockResolvedValue(undefined),
            release_poll: vi.fn(),
        };
        mock_next = vi.fn() as NextFunction;

        controller = new RegisterController(
            test_config,
            pool as unknown as pg.Pool,
            poll_hold as unknown as PollHoldService,
        );
    });

    // ── register ────────────────────────────────────────────────────────

    describe('register', () => {
        it('successfully registers a daemon and returns correct response', async () => {
            pool.query.mockResolvedValueOnce({ rows: [] });

            const req = mock_req({
                body: {
                    daemon_id: 'daemon-1',
                    version: '2.1.0',
                    capabilities: { sync: true },
                },
            });
            const res = mock_res();

            await controller.register(req, res, mock_next);

            // Verify the DB update sets online + relay public_url
            expect(pool.query).toHaveBeenCalledWith(
                expect.stringContaining("SET status = 'online'"),
                [
                    expect.any(Number),
                    'http://localhost:4901/v1/relay/daemon-1',
                    'daemon-1',
                ],
            );

            // Verify response shape
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    registered: true,
                    poll_interval_ms: 30000,
                }),
            );

            // server_time should be an ISO string
            const json_arg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
            expect(json_arg.server_time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });

        it('returns 400 on invalid body (missing daemon_id)', async () => {
            const req = mock_req({ body: { version: '1.0' } });
            const res = mock_res();

            await controller.register(req, res, mock_next);

            expect(mock_next).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 400,
                    code: 'invalid_body',
                }),
            );
        });

        it('returns 403 if daemon_auth does not match', async () => {
            const req = mock_req({
                body: { daemon_id: 'daemon-1' },
                daemon_auth: { daemon_id: 'other-daemon' },
            });
            const res = mock_res();

            await controller.register(req, res, mock_next);

            expect(mock_next).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 403,
                    code: 'forbidden',
                }),
            );
        });
    });

    // ── deregister ──────────────────────────────────────────────────────

    describe('deregister', () => {
        it('marks daemon offline, expires commands, and rejects waiters', async () => {
            // mark offline
            pool.query.mockResolvedValueOnce({ rows: [] });

            // expire pending/delivered
            pool.query.mockResolvedValueOnce({ rows: [] });

            const req = mock_req({
                body: { daemon_id: 'daemon-1', reason: 'shutdown' },
            });
            const res = mock_res();

            await controller.deregister(req, res, mock_next);

            // Verify daemon set offline
            expect(pool.query).toHaveBeenCalledWith(
                expect.stringContaining("SET status = 'offline'"),
                ['daemon-1'],
            );

            // Verify commands expired
            expect(pool.query).toHaveBeenCalledWith(
                expect.stringContaining("SET status = 'expired'"),
                ['daemon-1'],
            );

            // Waiters rejected via batch helper (queries its own command ids)
            expect(poll_hold.reject_all_for_daemon).toHaveBeenCalledWith(
                'daemon-1',
                expect.any(Error),
            );
            expect(poll_hold.release_poll).toHaveBeenCalledWith('daemon-1');

            // Verify response
            expect(res.json).toHaveBeenCalledWith({ deregistered: true });
        });

        it('releases held poll on deregister', async () => {
            pool.query
                .mockResolvedValueOnce({ rows: [] })   // mark offline
                .mockResolvedValueOnce({ rows: [] });  // no expired commands

            const req = mock_req({
                body: { daemon_id: 'daemon-1' },
            });
            const res = mock_res();

            await controller.deregister(req, res, mock_next);

            expect(poll_hold.release_poll).toHaveBeenCalledWith('daemon-1');
        });

        it('returns 400 on invalid body (missing daemon_id)', async () => {
            const req = mock_req({ body: { reason: 'going away' } });
            const res = mock_res();

            await controller.deregister(req, res, mock_next);

            expect(mock_next).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 400,
                    code: 'invalid_body',
                }),
            );
        });

        it('returns 403 if daemon_auth does not match', async () => {
            const req = mock_req({
                body: { daemon_id: 'daemon-1' },
                daemon_auth: { daemon_id: 'intruder' },
            });
            const res = mock_res();

            await controller.deregister(req, res, mock_next);

            expect(mock_next).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: 403,
                    code: 'forbidden',
                }),
            );
        });
    });
});
