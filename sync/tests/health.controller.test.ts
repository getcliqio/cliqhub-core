/**
 * Tests for HealthController — liveness probe and readiness probe.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

import { HealthController } from '../src/controllers/health.controller.js';
import type { NotifyService } from '../src/services/notify.service.js';

function make_pool(query_fn?: (...args: unknown[]) => unknown) {
    return {
        query: vi.fn(query_fn ?? (() => ({ rows: [{ count: '0' }] }))),
    };
}

function make_notify_service(connected = true) {
    return { connected } as unknown as NotifyService;
}

function mock_res() {
    const r = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };
    return r as unknown as Response;
}

const mock_req = {} as Request;

describe('HealthController', () => {
    describe('check (liveness)', () => {
        it('returns 200 with metrics when healthy', async () => {
            const pool = make_pool((sql: string) => {
                if (typeof sql === 'string' && sql.includes('daemons')) {
                    return { rows: [{ count: '5' }] };
                }
                if (typeof sql === 'string' && sql.includes('failed')) {
                    return { rows: [{ count: '2' }] };
                }
                if (typeof sql === 'string' && sql.includes('expired')) {
                    return { rows: [{ count: '7' }] };
                }
                return { rows: [{ count: '0' }] };
            });

            const notify = make_notify_service(true);
            const controller = new HealthController(pool as any, notify);
            const res = mock_res();

            await controller.check(mock_req, res);

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                status: 'ok',
                notify_connected: true,
                pg_connected: true,
            }));
        });

        it('returns 503 when DB query fails', async () => {
            const pool = make_pool(() => { throw new Error('pg down'); });
            const notify = make_notify_service(false);
            const controller = new HealthController(pool as any, notify);
            const res = mock_res();

            await controller.check(mock_req, res);

            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                status: 'degraded',
                pg_connected: false,
                notify_connected: false,
            }));
        });

        it('includes notify_connected: false when NOTIFY is disconnected', async () => {
            const pool = make_pool(() => ({ rows: [{ count: '0' }] }));
            const notify = make_notify_service(false);
            const controller = new HealthController(pool as any, notify);
            const res = mock_res();

            await controller.check(mock_req, res);

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                status: 'ok',
                notify_connected: false,
                pg_connected: true,
            }));
        });
    });

    describe('ready (readiness probe)', () => {
        it('returns 200 when NOTIFY and PG are healthy', async () => {
            const pool = make_pool();
            const notify = make_notify_service(true);
            const controller = new HealthController(pool as any, notify);
            const res = mock_res();

            await controller.ready(mock_req, res);

            expect(res.json).toHaveBeenCalledWith({ ready: true });
        });

        it('returns 503 when NOTIFY is disconnected', async () => {
            const pool = make_pool();
            const notify = make_notify_service(false);
            const controller = new HealthController(pool as any, notify);
            const res = mock_res();

            await controller.ready(mock_req, res);

            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json).toHaveBeenCalledWith({
                ready: false,
                reason: 'notify_disconnected',
            });
        });

        it('returns 503 when PG query fails', async () => {
            const pool = make_pool(() => { throw new Error('connection refused'); });
            const notify = make_notify_service(true);
            const controller = new HealthController(pool as any, notify);
            const res = mock_res();

            await controller.ready(mock_req, res);

            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json).toHaveBeenCalledWith({
                ready: false,
                reason: 'pg_disconnected',
            });
        });
    });
});
