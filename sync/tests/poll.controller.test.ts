import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';

import { PollController } from '../src/controllers/poll.controller.js';
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

describe('PollController', () => {
    let pool: { query: ReturnType<typeof vi.fn> };
    let poll_hold: {
        hold_poll: ReturnType<typeof vi.fn>;
        resolve_waiter: ReturnType<typeof vi.fn>;
    };
    let controller: PollController;
    let mock_next: NextFunction;

    beforeEach(() => {
        pool = { query: vi.fn() };
        poll_hold = {
            hold_poll: vi.fn(),
            resolve_waiter: vi.fn(),
        };
        mock_next = vi.fn() as NextFunction;

        controller = new PollController(
            test_config,
            pool as unknown as pg.Pool,
            poll_hold as unknown as PollHoldService,
        );
    });

    it('returns 400 on invalid body (missing daemon_id)', async () => {
        const req = mock_req({ body: {} });
        const res = mock_res();

        await controller.poll(req, res, mock_next);

        // Zod validation failure should be passed to next as SyncError(400)
        expect(mock_next).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 400,
                code: 'invalid_body',
            }),
        );
    });

    it('returns 403 if daemon_auth.daemon_id does not match request daemon_id', async () => {
        const req = mock_req({
            body: { daemon_id: 'daemon-1', responses: [] },
            daemon_auth: { daemon_id: 'different-daemon' },
        });
        const res = mock_res();

        await controller.poll(req, res, mock_next);

        expect(mock_next).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 403,
                code: 'forbidden',
            }),
        );
    });

    it('processes responses: writes to DB and resolves local waiter', async () => {
        const command_response = {
            command_id: 'cmd-1',
            status_code: 200,
            headers: { 'content-type': 'application/json' },
            body: { data: 'hello' },
        };

        poll_hold.resolve_waiter.mockReturnValue(true);

        // Queries in order:
        // 1. insert response, 2. update command status, 3. heartbeat update, 4. fetch pending
        pool.query
            .mockResolvedValueOnce({ rows: [] })   // insert response
            .mockResolvedValueOnce({ rows: [] })   // update command completed
            .mockResolvedValueOnce({ rows: [] })   // heartbeat update
            .mockResolvedValueOnce({ rows: [] });  // fetch pending (none)

        poll_hold.hold_poll.mockResolvedValue([]);

        // After hold wakes, re-query also returns nothing
        pool.query.mockResolvedValueOnce({ rows: [] });

        const req = mock_req({
            body: { daemon_id: 'daemon-1', responses: [command_response] },
        });
        const res = mock_res();

        await controller.poll(req, res, mock_next);

        // Verify response was inserted into DB
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO cliq.sync_command_responses'),
            expect.arrayContaining(['cmd-1', 200]),
        );

        // Verify command was marked completed
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining("SET status = 'completed'"),
            ['cmd-1'],
        );

        // Verify local waiter was resolved
        expect(poll_hold.resolve_waiter).toHaveBeenCalledWith('cmd-1', {
            status_code: 200,
            headers: { 'content-type': 'application/json' },
            body: { data: 'hello' },
        });
    });

    it('sends pg_notify when local waiter is not found', async () => {
        const command_response = {
            command_id: 'cmd-remote',
            status_code: 201,
            body: null,
        };

        // Local waiter not found — resolve_waiter returns false
        poll_hold.resolve_waiter.mockReturnValue(false);

        pool.query
            .mockResolvedValueOnce({ rows: [] })   // insert response
            .mockResolvedValueOnce({ rows: [] })   // update command completed
            .mockResolvedValueOnce({ rows: [] })   // pg_notify for remote
            .mockResolvedValueOnce({ rows: [] })   // heartbeat update
            .mockResolvedValueOnce({ rows: [] });  // fetch pending (none)

        poll_hold.hold_poll.mockResolvedValue([]);
        pool.query.mockResolvedValueOnce({ rows: [] }); // re-query after wake

        const req = mock_req({
            body: { daemon_id: 'daemon-1', responses: [command_response] },
        });
        const res = mock_res();

        await controller.poll(req, res, mock_next);

        // pg_notify should have been sent for the response channel
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining('pg_notify'),
            ['sync_response_ready', 'cmd-remote'],
        );
    });

    it('updates heartbeat on every poll', async () => {
        pool.query
            .mockResolvedValueOnce({ rows: [] })   // heartbeat
            .mockResolvedValueOnce({ rows: [] });  // fetch pending (none)

        poll_hold.hold_poll.mockResolvedValue([]);
        pool.query.mockResolvedValueOnce({ rows: [] }); // re-query after wake

        const req = mock_req({
            body: { daemon_id: 'daemon-1', responses: [] },
        });
        const res = mock_res();

        await controller.poll(req, res, mock_next);

        // At least one query should update heartbeat
        const heartbeat_call = pool.query.mock.calls.find(
            (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('last_heartbeat'),
        );
        expect(heartbeat_call).toBeDefined();
        expect(heartbeat_call![1][1]).toBe('daemon-1');
    });

    it('returns commands immediately when pending commands exist', async () => {
        const pending_command = {
            id: 'cmd-99',
            method: 'POST',
            path: '/v1/workspace/sync',
            headers: null,
            body: { key: 'value' },
        };

        pool.query
            .mockResolvedValueOnce({ rows: [] })                   // heartbeat
            .mockResolvedValueOnce({ rows: [pending_command] });   // fetch pending — found!

        const req = mock_req({
            body: { daemon_id: 'daemon-1', responses: [] },
        });
        const res = mock_res();

        await controller.poll(req, res, mock_next);

        // Should respond immediately without holding
        expect(poll_hold.hold_poll).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith({
            commands: [
                {
                    id: 'cmd-99',
                    method: 'POST',
                    path: '/v1/workspace/sync',
                    headers: undefined,
                    body: { key: 'value' },
                },
            ],
        });
    });

    it('holds poll when no commands, then re-queries after wake', async () => {
        const woken_command = {
            id: 'cmd-woken',
            method: 'GET',
            path: '/v1/status',
            headers: { 'x-request-id': 'abc' },
            body: null,
        };

        pool.query
            .mockResolvedValueOnce({ rows: [] })               // heartbeat
            .mockResolvedValueOnce({ rows: [] });              // first fetch — empty

        // hold_poll resolves (woken up)
        poll_hold.hold_poll.mockResolvedValue([]);

        // Re-query after wake returns the command
        pool.query.mockResolvedValueOnce({ rows: [woken_command] });

        const req = mock_req({
            body: { daemon_id: 'daemon-1', responses: [] },
        });
        const res = mock_res();

        await controller.poll(req, res, mock_next);

        // Should have held the poll
        expect(poll_hold.hold_poll).toHaveBeenCalledWith('daemon-1', 30000);

        // Should respond with the command found after wake
        expect(res.json).toHaveBeenCalledWith({
            commands: [
                {
                    id: 'cmd-woken',
                    method: 'GET',
                    path: '/v1/status',
                    headers: { 'x-request-id': 'abc' },
                    body: null,
                },
            ],
        });
    });

    it('passes unexpected errors to next()', async () => {
        const db_error = new Error('connection reset');
        pool.query.mockRejectedValueOnce(db_error);

        const req = mock_req({
            body: { daemon_id: 'daemon-1', responses: [] },
        });
        const res = mock_res();

        await controller.poll(req, res, mock_next);

        expect(mock_next).toHaveBeenCalledWith(db_error);
    });
});
