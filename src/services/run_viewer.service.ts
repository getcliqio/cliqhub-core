/**
 * RunViewerService — tracks active SSE viewers per run and signals
 * daemons to start/stop event streaming via the command outbox.
 *
 * In-memory viewer tracking (per-process). Hub SSE connection lifecycle
 * calls `add_viewer()` on open and `remove_viewer()` on close.
 *
 * On first viewer: enqueues `stream_subscribe` to the run's daemon.
 * On last viewer gone: enqueues `stream_unsubscribe`.
 *
 * Fire-and-forget — max_attempts: 1, no dedup needed. If the daemon
 * is offline, there's nothing to stream anyway.
 */

import { QueryTypes } from 'sequelize';

import { get_sequelize } from '../lib/sequelize.js';
import { command_outbox_enqueue } from './command_outbox.service.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('run-viewer');

/** In-memory set of viewer IDs per run. */
const _viewers = new Map<string, Set<string>>();


/**
 * Register a viewer for a run. If this is the first viewer,
 * sends `stream_subscribe` to the run's daemon.
 *
 * Returns the daemon_id if found (used for logging/diagnostics).
 */
export async function add_viewer(
    run_id: string,
    viewer_id: string,
): Promise<string | null> {
    let set = _viewers.get(run_id);
    if (!set) {
        set = new Set();
        _viewers.set(run_id, set);
    }

    const was_empty = set.size === 0;
    set.add(viewer_id);

    if (!was_empty) {
        // Already streaming — no command needed.
        return null;
    }

    // First viewer — tell the daemon to start streaming events.
    const daemon_id = await _resolve_daemon_id(run_id);
    if (!daemon_id) {
        log.warn(`no daemon_id for run ${run_id} — cannot subscribe`);
        return null;
    }

    try {
        await command_outbox_enqueue(
            daemon_id,
            '/v1/runs/events/subscribe',
            { run_id, viewer_id },
            { max_attempts: 1 },
        );
        log.info(`stream_subscribe sent for run=${run_id} daemon=${daemon_id}`);
    } catch (err) {
        log.warn(`stream_subscribe failed for run=${run_id}: ${(err as Error).message}`);
    }

    return daemon_id;
}

/**
 * Remove a viewer from a run. If this was the last viewer,
 * sends `stream_unsubscribe` to the run's daemon.
 */
export async function remove_viewer(
    run_id: string,
    viewer_id: string,
): Promise<void> {
    const set = _viewers.get(run_id);
    if (!set) return;

    set.delete(viewer_id);
    if (set.size > 0) return;

    // Last viewer gone — tell daemon to stop streaming.
    _viewers.delete(run_id);

    const daemon_id = await _resolve_daemon_id(run_id);
    if (!daemon_id) return;

    try {
        await command_outbox_enqueue(
            daemon_id,
            '/v1/runs/events/unsubscribe',
            { run_id, viewer_id },
            { max_attempts: 1 },
        );
        log.info(`stream_unsubscribe sent for run=${run_id} daemon=${daemon_id}`);
    } catch (err) {
        log.warn(`stream_unsubscribe failed for run=${run_id}: ${(err as Error).message}`);
    }
}

/** Check if a run currently has active viewers. */
export function has_viewers(run_id: string): boolean {
    const set = _viewers.get(run_id);
    return set !== undefined && set.size > 0;
}

/** Get the number of active viewers for a run. */
export function viewer_count(run_id: string): number {
    return _viewers.get(run_id)?.size ?? 0;
}

/** Reset all viewer state (tests only). */
export function _test_reset(): void {
    _viewers.clear();
}


// ─── Internal ────────────────────────────────────────────────────────

/**
 * Look up the daemon_id for a run from the team_runs table.
 * Returns null if the run doesn't exist or has no daemon.
 */
async function _resolve_daemon_id(run_id: string): Promise<string | null> {
    const sq = get_sequelize();
    const [rows] = await sq.query(
        `SELECT daemon_id FROM cliq.team_runs WHERE run_id = :run_id LIMIT 1`,
        { replacements: { run_id }, type: QueryTypes.SELECT, plain: true },
    ) as unknown as [{ daemon_id: string | null } | null, unknown];
    return rows?.daemon_id ?? null;
}
