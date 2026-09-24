/**
 * Tests for command_outbox.service.ts — Hub → Daemon durable delivery.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

const mock_query = vi.fn();
vi.mock('../../../src/lib/sequelize.js', () => ({
    get_sequelize: () => ({ query: mock_query }),
}));

vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    }),
}));

vi.mock('../../../src/models/index.js', () => ({
    Daemon: { findByPk: vi.fn() },
    RealmMember: { findAll: vi.fn() },
}));

vi.mock('../../../src/services/realm.service.js', () => ({
    RealmService: {
        list_realms_for_daemon: vi.fn(async () => []),
    },
}));

vi.mock('../../../src/services/dispatch_auth.service.js', () => ({
    DispatchAuthService: {
        authorization_header: vi.fn(async () => 'Bearer test-jwt'),
    },
}));

import { Daemon } from '../../../src/models/index.js';
import { RealmService } from '../../../src/services/realm.service.js';
import {
    command_outbox_enqueue,
    start_command_outbox_worker,
    stop_command_outbox_worker,
    _test_poll_cycle,
} from '../../../src/services/command_outbox.service.js';

describe('command_outbox.service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        stop_command_outbox_worker();
    });

    // ── Enqueue ──────────────────────────────────────────────────────

    describe('command_outbox_enqueue', () => {
        it('inserts a row with generated tx_id and enriched payload', async () => {
            mock_query.mockResolvedValue([1]);

            const result = await command_outbox_enqueue('d-1', '/v1/execute', {
                run_id: 'r-1',
                workspace_dir: '/tmp',
            });

            expect(result.tx_id).toBeTruthy();
            expect(mock_query).toHaveBeenCalledTimes(1);

            const [sql, opts] = mock_query.mock.calls[0];
            expect(sql).toContain('INSERT INTO cliq."command_outbox"');
            expect(opts.replacements.daemon_id).toBe('d-1');
            expect(opts.replacements.endpoint).toBe('/v1/execute');

            // Payload should include tx_id.
            const payload = JSON.parse(opts.replacements.payload);
            expect(payload.tx_id).toBe(result.tx_id);
            expect(payload.run_id).toBe('r-1');
        });

        it('uses custom max_attempts when provided', async () => {
            mock_query.mockResolvedValue([1]);

            await command_outbox_enqueue('d-1', '/v1/install', { scope: 'cliq' }, { max_attempts: 10 });

            const [, opts] = mock_query.mock.calls[0];
            expect(opts.replacements.max_attempts).toBe(10);
        });
    });

    // ── Delivery Worker ──────────────────────────────────────────────

    describe('delivery worker', () => {
        it('delivers a pending entry and marks delivered_at', async () => {
            // Poll returns one pending entry.
            mock_query
                .mockResolvedValueOnce([{
                    tx_id: 'tx-1',
                    daemon_id: 'd-1',
                    endpoint: '/v1/execute',
                    payload: JSON.stringify({ tx_id: 'tx-1', run_id: 'r-1' }),
                    attempts: 0,
                    max_attempts: 5,
                    created_at: Date.now() - 10_000,
                }])
                // UPDATE for delivered_at
                .mockResolvedValueOnce([1]);

            vi.mocked(Daemon.findByPk).mockResolvedValue({
                id: 'd-1',
                public_url: 'http://localhost:9999',
                status: 'online',
            } as never);

            vi.mocked(RealmService.list_realms_for_daemon).mockResolvedValue([
                { id: 'realm-1' },
            ] as never);

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({ ok: true }),
            }));

            await _test_poll_cycle();

            // fetch should have been called with the daemon URL.
            expect(fetch).toHaveBeenCalledWith(
                'http://localhost:9999/v1/execute',
                expect.objectContaining({ method: 'POST' }),
            );

            // Second query call is the UPDATE for delivered_at.
            expect(mock_query).toHaveBeenCalledTimes(2);
            const [update_sql] = mock_query.mock.calls[1];
            expect(update_sql).toContain('delivered_at');
        });

        it('increments attempts on 5xx failure', async () => {
            mock_query
                .mockResolvedValueOnce([{
                    tx_id: 'tx-2',
                    daemon_id: 'd-1',
                    endpoint: '/v1/install',
                    payload: JSON.stringify({ tx_id: 'tx-2' }),
                    attempts: 0,
                    max_attempts: 5,
                    created_at: Date.now() - 10_000,
                }])
                .mockResolvedValueOnce([1]);

            vi.mocked(Daemon.findByPk).mockResolvedValue({
                id: 'd-1',
                public_url: 'http://localhost:9999',
                status: 'online',
            } as never);

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status: 503,
            }));

            await _test_poll_cycle();

            // Should increment attempts.
            const [update_sql, opts] = mock_query.mock.calls[1];
            expect(update_sql).toContain('"attempts" = "attempts" + 1');
            expect(opts.replacements.error).toContain('503');
        });

        it('marks permanent failure on 4xx (non-401)', async () => {
            mock_query
                .mockResolvedValueOnce([{
                    tx_id: 'tx-3',
                    daemon_id: 'd-1',
                    endpoint: '/v1/uninstall',
                    payload: JSON.stringify({ tx_id: 'tx-3' }),
                    attempts: 0,
                    max_attempts: 5,
                    created_at: Date.now() - 10_000,
                }])
                .mockResolvedValueOnce([1]);

            vi.mocked(Daemon.findByPk).mockResolvedValue({
                id: 'd-1',
                public_url: 'http://localhost:9999',
                status: 'online',
            } as never);

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status: 404,
            }));

            await _test_poll_cycle();

            // Should exhaust max_attempts.
            const [update_sql] = mock_query.mock.calls[1];
            expect(update_sql).toContain('"attempts" = "max_attempts"');
        });

        it('skips delivery when daemon has no public_url, bumps created_at to unblock the FIFO batch', async () => {
            // Regression: previously the skip path returned early without
            // touching created_at, so an orphan entry sat at
            // `ORDER BY created_at ASC LIMIT 20` position #1 forever and
            // starved newer entries in the same batch cycle. With the fix,
            // we still don't increment attempts (daemon may come back),
            // but we push the entry to the tail of the queue.
            mock_query
                .mockResolvedValueOnce([{
                    tx_id: 'tx-4',
                    daemon_id: 'd-1',
                    endpoint: '/v1/execute',
                    payload: JSON.stringify({ tx_id: 'tx-4' }),
                    attempts: 0,
                    max_attempts: 5,
                    created_at: Date.now() - 24 * 60 * 60 * 1000,
                }])
                // UPDATE that bumps created_at
                .mockResolvedValueOnce([1]);

            vi.mocked(Daemon.findByPk).mockResolvedValue({
                id: 'd-1',
                public_url: null,
                status: 'online',
            } as never);

            await _test_poll_cycle();

            // SELECT + one UPDATE (increment attempts so entry eventually GCs).
            expect(mock_query).toHaveBeenCalledTimes(2);
            const [update_sql, update_opts] = mock_query.mock.calls[1];
            expect(update_sql).toContain('"attempts"');
            expect(update_sql).toContain('"created_at" = :now');
            expect(update_opts.replacements.tx_id).toBe('tx-4');
            // Bumped to ~now (within 5s), not stuck at the day-old original.
            const bumped_to = update_opts.replacements.now as number;
            expect(Date.now() - bumped_to).toBeLessThan(5_000);
        });

        it('no-ops when outbox is empty', async () => {
            mock_query.mockResolvedValueOnce([]);

            await _test_poll_cycle();

            expect(mock_query).toHaveBeenCalledTimes(1);
        });

        it('detects daemon run_not_found (404 + run_not_found body): marks state_lost_at, purges other queued commands, exhausts entry', async () => {
            // Mocked in order: SELECT pending → UPDATE team_runs
            // (state_lost_at) → UPDATE command_outbox (purge siblings)
            // → UPDATE command_outbox (exhaust this entry).
            // The run-log append is a lazy dynamic import — the test
            // doesn't need to intercept it because it's caught in a
            // try/catch and best-effort.
            mock_query
                .mockResolvedValueOnce([{
                    tx_id: 'tx-orphan',
                    daemon_id: 'd-1',
                    endpoint: '/v1/resume',
                    payload: JSON.stringify({
                        tx_id: 'tx-orphan',
                        run_id: 'r-lost',
                        from_phase: 'open-pr',
                    }),
                    attempts: 0,
                    max_attempts: 5,
                    created_at: Date.now() - 10_000,
                }])
                .mockResolvedValueOnce([1])  // UPDATE team_runs
                .mockResolvedValueOnce([1])  // UPDATE command_outbox (purge siblings)
                .mockResolvedValueOnce([1]); // UPDATE command_outbox (exhaust this entry)

            vi.mocked(Daemon.findByPk).mockResolvedValue({
                id: 'd-1',
                public_url: 'http://localhost:9999',
                status: 'online',
            } as never);

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status: 404,
                text: async () => JSON.stringify({
                    ok: false,
                    error: 'run_not_found',
                    message: "Run 'r-lost' not found",
                }),
            }));

            await _test_poll_cycle();

            // Second query: stamps state_lost_at + flips live runs to crashed.
            const [orphan_sql, orphan_opts] = mock_query.mock.calls[1];
            expect(orphan_sql).toContain('state_lost_at');
            expect(orphan_sql).toContain('team_runs');
            expect(orphan_sql).toContain('crashed');
            expect(orphan_opts.replacements.run_id).toBe('r-lost');
            expect(orphan_opts.replacements.error).toMatch(/lost.*local state/i);

            // Third query: purges sibling commands for the same run.
            const [purge_sql, purge_opts] = mock_query.mock.calls[2];
            expect(purge_sql).toContain('command_outbox');
            expect(purge_sql).toContain("'run_id'");
            expect(purge_sql).toContain('superseded by orphaned-run detection');
            expect(purge_opts.replacements.run_id).toBe('r-lost');
            expect(purge_opts.replacements.tx_id).toBe('tx-orphan');

            // Fourth query: exhaust this entry.
            const [exhaust_sql] = mock_query.mock.calls[3];
            expect(exhaust_sql).toContain('"attempts" = "max_attempts"');
        });

        it('still treats generic 404 (no run_not_found body) as plain permanent failure — no orphan side-effects', async () => {
            // Regression guard: only responses that positively identify
            // as run_not_found should trigger the orphan path. A generic
            // 404 (e.g. bad URL) must NOT stamp state_lost_at.
            mock_query
                .mockResolvedValueOnce([{
                    tx_id: 'tx-generic',
                    daemon_id: 'd-1',
                    endpoint: '/v1/uninstall',
                    payload: JSON.stringify({ tx_id: 'tx-generic' }),
                    attempts: 0,
                    max_attempts: 5,
                    created_at: Date.now() - 10_000,
                }])
                .mockResolvedValueOnce([1]);

            vi.mocked(Daemon.findByPk).mockResolvedValue({
                id: 'd-1',
                public_url: 'http://localhost:9999',
                status: 'online',
            } as never);

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status: 404,
                text: async () => 'Not Found',
            }));

            await _test_poll_cycle();

            // Exactly one UPDATE — the exhaust step. NO team_runs write.
            expect(mock_query).toHaveBeenCalledTimes(2);
            const [update_sql] = mock_query.mock.calls[1];
            expect(update_sql).not.toContain('state_lost_at');
            expect(update_sql).toContain('"attempts" = "max_attempts"');
        });
    });

    // ── Lifecycle ────────────────────────────────────────────────────

    describe('lifecycle', () => {
        it('start and stop are idempotent', () => {
            start_command_outbox_worker();
            start_command_outbox_worker(); // double-start is no-op
            stop_command_outbox_worker();
            stop_command_outbox_worker(); // double-stop is no-op
        });
    });
});
