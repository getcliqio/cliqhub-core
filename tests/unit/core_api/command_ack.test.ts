/**
 * Tests for the CommandAckController.
 *
 * Uses mock Sequelize query to simulate the command_outbox table.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// ── Mocks ────────────────────────────────────────────────────────────

// In-memory command_outbox rows.
const _outbox = new Map<string, { tx_id: string; acked_at: number | null; ack_status: string | null }>();

vi.mock('../../../src/db/control_plane_store.js', () => ({
    get_control_plane_store: vi.fn(() => ({
        sequelize: {
            query: vi.fn(async (sql: string, opts: { replacements?: unknown[] }) => {
                const trimmed = sql.trim().toUpperCase();
                const params = opts.replacements ?? [];

                // SELECT lookup.
                if (trimmed.startsWith('SELECT')) {
                    const tx_id = params[0] as string;
                    const row = _outbox.get(tx_id);
                    return [row ? [row] : []];
                }

                // UPDATE ack.
                if (trimmed.startsWith('UPDATE')) {
                    const [acked_at, ack_status, _ack_data, _ack_error, tx_id] = params as unknown[];
                    const row = _outbox.get(tx_id as string);
                    if (row && !row.acked_at) {
                        row.acked_at = acked_at as number;
                        row.ack_status = ack_status as string;
                    }
                    return [[], 1];
                }

                return [[], 0];
            }),
        },
    })),
}));

vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }),
}));

import { CommandAckController } from '../../../src/controllers/command_ack_controller.js';

// ── Helpers ──────────────────────────────────────────────────────────

function mock_res() {
    const res = {
        _status: 200,
        _body: null as unknown,
        statusCode: 200,
        status(code: number) {
            this._status = code;
            this.statusCode = code;
            return this;
        },
        json(body: unknown) {
            this._body = body;
            return this;
        },
    };
    return res as unknown as Response & { _status: number; _body: unknown };
}

function mock_req(body: Record<string, unknown>) {
    return { body } as unknown as Request;
}

// ── Setup ────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    _outbox.clear();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('CommandAckController.ack_command', () => {
    it('records ack for an existing unacked command', async () => {
        _outbox.set('cmd-1', { tx_id: 'cmd-1', acked_at: null, ack_status: null });

        const req = mock_req({
            tx_id: 'ack-tx-1',
            command_tx_id: 'cmd-1',
            daemon_id: 'd-1',
            status: 'ok',
        });
        const res = mock_res();
        const next = vi.fn();

        await CommandAckController.ack_command(req, res, next);

        expect(res._status).toBe(200);
        expect((res._body as Record<string, unknown>).ok).toBe(true);
        expect(_outbox.get('cmd-1')!.acked_at).not.toBeNull();
        expect(_outbox.get('cmd-1')!.ack_status).toBe('ok');
    });

    it('returns 200 for unknown command_tx_id (may bypass outbox)', async () => {
        const req = mock_req({
            tx_id: 'ack-tx-2',
            command_tx_id: 'nonexistent',
            daemon_id: 'd-1',
            status: 'ok',
        });
        const res = mock_res();
        const next = vi.fn();

        await CommandAckController.ack_command(req, res, next);

        // Unknown tx_id is treated as no-op (the command may have been
        // dispatched via direct HTTP rather than the command outbox).
        expect(res._status).toBe(200);
        expect((res._body as Record<string, unknown>).ok).toBe(true);
    });

    it('is idempotent — re-ack returns ok without updating', async () => {
        _outbox.set('cmd-2', { tx_id: 'cmd-2', acked_at: 12345, ack_status: 'ok' });

        const req = mock_req({
            tx_id: 'ack-tx-3',
            command_tx_id: 'cmd-2',
            daemon_id: 'd-1',
            status: 'error',
        });
        const res = mock_res();
        const next = vi.fn();

        await CommandAckController.ack_command(req, res, next);

        expect(res._status).toBe(200);
        expect((res._body as Record<string, unknown>).ok).toBe(true);
        // ack_status unchanged — still 'ok' from original.
        expect(_outbox.get('cmd-2')!.ack_status).toBe('ok');
    });

    it('records error acks', async () => {
        _outbox.set('cmd-3', { tx_id: 'cmd-3', acked_at: null, ack_status: null });

        const req = mock_req({
            tx_id: 'ack-tx-4',
            command_tx_id: 'cmd-3',
            daemon_id: 'd-1',
            status: 'error',
            error: 'team not found',
        });
        const res = mock_res();
        const next = vi.fn();

        await CommandAckController.ack_command(req, res, next);

        expect(res._status).toBe(200);
        expect(_outbox.get('cmd-3')!.ack_status).toBe('error');
    });

    it('rejects invalid body (missing required fields)', async () => {
        const req = mock_req({ tx_id: 'ack-tx-5' }); // missing command_tx_id, daemon_id, status
        const res = mock_res();
        const next = vi.fn();

        await CommandAckController.ack_command(req, res, next);

        // Zod error passed to next.
        expect(next).toHaveBeenCalled();
    });
});
