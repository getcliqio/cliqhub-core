/**
 * Run Reaper — marks non-terminal Hub runs as crashed when:
 *   1. Their assigned daemon has stopped heartbeating, OR
 *   2. Their Hub action lease (`lease_expires_at`) has passed
 *      (even if the daemon still heartbeats — covers "execute accepted,
 *      complete never arrived").
 *
 * See DESIGN-control-message-reliability Phase 3.
 *
 * The daemon's local run state is unaffected — this only fixes the Hub's
 * mirror. If a run is falsely reaped, the daemon can overwrite with the
 * real terminal state via complete.
 */

import { Op, QueryTypes } from 'sequelize';
import { Daemon } from '../models/index.js';
import { get_sequelize } from '../lib/sequelize.js';

// RunService is imported lazily inside crash_and_emit so this module
// stays cheap to load in tests that mock the models layer minimally
// (see tests/unit/run_reaper.service.test.ts). Loading RunService at
// module-eval time would trigger its static _run_includes initializer,
// which touches Team/Scope/Workspace models the reaper doesn't need.

const REAPER_INTERVAL_MS = parseInt(
    process.env.RUN_REAPER_INTERVAL_MS ?? '60000', 10,
);
const STALE_THRESHOLD_MS = parseInt(
    process.env.DAEMON_STALE_THRESHOLD_MS ?? '90000', 10,
);

let _timer: ReturnType<typeof setInterval> | null = null;

/**
 * UPDATE + RETURNING helper: bulk-crash a set of runs matching `where`
 * and emit run.crashed for each row we actually touched. Postgres
 * RETURNING is supported by Sequelize's raw query, so we get one round
 * trip instead of SELECT-then-UPDATE.
 */
async function crash_and_emit(
    where_sql: string,
    replacements: Record<string, unknown>,
    error_message: string,
): Promise<number> {
    const sequelize = get_sequelize();
    const rows = (await sequelize.query(
        `UPDATE cliq."team_runs"
         SET "state" = 'crashed',
             "completed_at" = :now,
             "error" = :error_message,
             "lease_expires_at" = NULL
         WHERE ${where_sql}
         RETURNING "run_id"`,
        {
            replacements: { ...replacements, now: Date.now(), error_message },
            type: QueryTypes.SELECT,
        },
    )) as unknown as Array<{ run_id: string }>;

    if (rows.length === 0) return 0;

    // Lazy-import to avoid pulling RunService (and its Team/Scope/Workspace
    // model-graph) into modules that mock the reaper's deps at unit-test
    // scope. See top-of-file note.
    const { RunService } = await import('./run.service.js');
    for (const row of rows) {
        // Deliberately best-effort — a broken bus mustn't stop the
        // reaper from making progress on the next batch.
        try {
            await RunService._emit_lifecycle(row.run_id, 'run.crashed', { error: error_message });
        } catch {
            /* swallow — see comment above */
        }
    }

    return rows.length;
}

/** Runs on daemons that stopped heartbeating. */
async function reap_stale_daemons(): Promise<number> {
    const cutoff = Date.now() - STALE_THRESHOLD_MS;

    const stale_daemon_ids = await Daemon.findAll({
        attributes: ['id'],
        where: {
            [Op.or]: [
                { last_heartbeat: { [Op.lt]: cutoff } },
                { last_heartbeat: null },
            ],
        },
        raw: true,
    });

    if (stale_daemon_ids.length === 0) return 0;

    const ids = stale_daemon_ids.map((d) => d.id);
    return crash_and_emit(
        `"state" IN ('running', 'awaiting_input')
           AND "daemon_id" IN (:ids)`,
        { ids },
        'daemon unresponsive',
    );
}

/**
 * Runs whose daemon no longer exists in the daemons table at all.
 * Covers the case where a daemon was deleted/re-registered and its old
 * runs were left orphaned — neither stale-daemon nor lease-expiry catches
 * these if the daemon row is gone and lease_expires_at is still in the future.
 */
async function reap_orphaned_daemons(): Promise<number> {
    return crash_and_emit(
        `"state" IN ('running', 'awaiting_input')
           AND "daemon_id" IS NOT NULL
           AND "daemon_id" NOT IN (SELECT "id" FROM cliq."daemons")`,
        {},
        'daemon no longer registered',
    );
}

/** Runs whose Hub action lease expired (daemon may still look alive). */
async function reap_expired_leases(): Promise<number> {
    return crash_and_emit(
        `"state" IN ('running', 'awaiting_input')
           AND "lease_expires_at" IS NOT NULL
           AND "lease_expires_at" < :now_lease`,
        { now_lease: Date.now() },
        'run lease expired',
    );
}

async function reap(): Promise<number> {
    const stale = await reap_stale_daemons();
    const orphaned = await reap_orphaned_daemons();
    const leases = await reap_expired_leases();
    const count = stale + orphaned + leases;
    if (stale > 0) {
        console.log(`[RunReaper] reaped ${stale} zombie run(s) from stale daemon(s)`);
    }
    if (orphaned > 0) {
        console.log(`[RunReaper] reaped ${orphaned} orphaned run(s) from deleted daemon(s)`);
    }
    if (leases > 0) {
        console.log(`[RunReaper] reaped ${leases} run(s) with expired action lease`);
    }
    return count;
}

/** Start the periodic reaper. Idempotent. Runs once immediately, then on interval. */
export function start_run_reaper(): void {
    if (_timer) return;
    console.log(
        `[RunReaper] started (interval=${REAPER_INTERVAL_MS}ms, threshold=${STALE_THRESHOLD_MS}ms)`,
    );

    // Run once immediately at startup to catch anything from a previous crash.
    reap().catch((err) => {
        console.error('[RunReaper] initial scan failed:', err instanceof Error ? err.message : err);
    });

    _timer = setInterval(() => {
        reap().catch((err) => {
            console.error('[RunReaper] scan failed:', err instanceof Error ? err.message : err);
        });
    }, REAPER_INTERVAL_MS);
    _timer.unref();
}

/** Stop the reaper (graceful shutdown). */
export function stop_run_reaper(): void {
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}

/** Test seam. */
export const _reap_for_tests = reap;
