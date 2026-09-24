/**
 * Unit tests for RunReaper lease expiry (action lease independent of daemon HB).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query_mock = vi.fn();
const find_all_mock = vi.fn();

vi.mock('../../src/lib/sequelize.js', () => ({
    get_sequelize: () => ({ query: (...args: unknown[]) => query_mock(...args) }),
}));

vi.mock('../../src/models/index.js', () => ({
    Daemon: { findAll: (...args: unknown[]) => find_all_mock(...args) },
    Run: {},
}));

// Slice 1.3 makes the reaper lazy-import RunService to emit run.crashed
// per crashed row. This unit test only cares about the reap-count contract,
// so stub the emission side to a no-op — otherwise the real RunService
// module load would need Team/Scope/Workspace models we've mocked away.
const emit_mock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/services/run.service.js', () => ({
    RunService: { _emit_lifecycle: emit_mock },
}));

import { _reap_for_tests, stop_run_reaper } from '../../src/services/run_reaper.service.js';

describe('RunReaper action lease', () => {
    beforeEach(() => {
        query_mock.mockReset();
        find_all_mock.mockReset();
        find_all_mock.mockResolvedValue([]);
        // Slice 1.3 flipped reap_* helpers to UPDATE ... RETURNING run_id
        // executed as QueryTypes.SELECT, so the mock now yields an array
        // of rows (empty by default). Count is derived from length, not
        // rowCount.
        query_mock.mockResolvedValue([]);
    });

    afterEach(() => {
        stop_run_reaper();
    });

    it('issues a lease-expiry UPDATE even when no daemons are stale', async () => {
        query_mock
            .mockResolvedValueOnce([])                                // orphaned daemons — no rows
            .mockResolvedValueOnce([{ run_id: 'r1' }, { run_id: 'r2' }]); // lease expiry — 2 rows

        const count = await _reap_for_tests();
        expect(count).toBe(2);
        expect(query_mock).toHaveBeenCalledTimes(2);
        // The lease-expiry query is the second call (after orphaned daemons).
        const sql = query_mock.mock.calls[1][0] as string;
        expect(sql).toContain('lease_expires_at');
        expect(sql).toContain('RETURNING "run_id"');
    });

    it('reaps stale daemons, orphaned daemons, and expired leases together', async () => {
        find_all_mock.mockResolvedValue([{ id: 'daemon-dead' }]);
        query_mock
            .mockResolvedValueOnce([{ run_id: 's1' }])                              // stale daemon runs — 1
            .mockResolvedValueOnce([])                                              // orphaned daemons — 0
            .mockResolvedValueOnce([{ run_id: 'l1' }, { run_id: 'l2' }, { run_id: 'l3' }]); // lease — 3

        const count = await _reap_for_tests();
        expect(count).toBe(4);
        expect(query_mock).toHaveBeenCalledTimes(3);
    });
});
