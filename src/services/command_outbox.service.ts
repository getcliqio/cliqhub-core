/**
 * Command Outbox Service — Hub → Daemon durable delivery.
 *
 * Every Hub-to-daemon command (execute, install, cancel, etc.) is
 * enqueued here instead of being POSTed inline. A delivery worker
 * drains the outbox per-daemon in FIFO order with retry/backoff.
 *
 * Hub callers get the `tx_id` back immediately. Daemon delivery is
 * asynchronous. The outbox guarantees at-least-once delivery; the
 * daemon-side `command_execution_log` ensures at-most-once execution.
 */

import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';

import { get_sequelize } from '../lib/sequelize.js';
import { get_logger } from '../lib/log.js';
import { Daemon, RealmMember } from '../models/index.js';
import { DispatchAuthService } from './dispatch_auth.service.js';
import { RealmService } from './realm.service.js';

const log = get_logger('command-outbox');

// ── Configuration ────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const MAX_ATTEMPTS_DEFAULT = 5;
const BASE_BACKOFF_MS = 2_000;
const GC_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour
const GC_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const STALE_ACK_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const STALE_ACK_DEFAULT_THRESHOLD_MS = 5 * 60 * 1000;
const STALE_ACK_EXECUTE_THRESHOLD_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

// ── Enqueue ──────────────────────────────────────────────────────────

export interface EnqueueResult {
    tx_id: string;
}

/**
 * Enqueue a command for delivery to a daemon.
 *
 * The `tx_id` is injected into the payload so the daemon can use it
 * for inbound dedup. The caller receives the `tx_id` immediately.
 */
export async function command_outbox_enqueue(
    daemon_id: string,
    endpoint: string,
    payload: Record<string, unknown>,
    opts?: { max_attempts?: number },
): Promise<EnqueueResult> {
    const sq = get_sequelize();
    const tx_id = randomUUID();
    const now = Date.now();
    const max_attempts = opts?.max_attempts ?? MAX_ATTEMPTS_DEFAULT;

    // Inject tx_id into the payload for receiver dedup.
    const enriched = { ...payload, tx_id };

    await sq.query(
        `INSERT INTO cliq."command_outbox"
            ("tx_id", "daemon_id", "endpoint", "payload", "attempts", "max_attempts", "created_at")
         VALUES (:tx_id, :daemon_id, :endpoint, :payload, 0, :max_attempts, :created_at)`,
        {
            replacements: {
                tx_id,
                daemon_id,
                endpoint,
                payload: JSON.stringify(enriched),
                max_attempts,
                created_at: now,
            },
            type: QueryTypes.INSERT,
        },
    );

    log.info('command_enqueued', { tx_id, daemon_id, endpoint });

    /** Deliver immediately instead of waiting for the next poll interval. */
    if (_running) {
        _poll_cycle().catch(() => {});
    }

    return { tx_id };
}

// ── Delivery Worker ──────────────────────────────────────────────────

let _worker_timer: ReturnType<typeof setInterval> | null = null;
let _gc_timer: ReturnType<typeof setInterval> | null = null;
let _stale_ack_timer: ReturnType<typeof setInterval> | null = null;
let _running = false;

interface PendingEntry {
    tx_id: string;
    daemon_id: string;
    endpoint: string;
    payload: string;
    attempts: number;
    max_attempts: number;
    created_at: number;
}

/**
 * Poll for pending entries and deliver them.
 *
 * We do NOT enforce strict per-daemon FIFO — a failed install should
 * not block an unrelated execute. The daemon's inbound command_dedup
 * middleware makes out-of-order or duplicate delivery safe.
 *
 * We cap the batch size to avoid overwhelming daemons or the DB.
 */
const POLL_BATCH_SIZE = 20;

async function _poll_cycle(): Promise<void> {
    if (!_running) return;
    const sq = get_sequelize();

    try {
        const rows = await sq.query<PendingEntry>(
            `SELECT "tx_id", "daemon_id", "endpoint", "payload"::text,
                    "attempts", "max_attempts", "created_at"
             FROM cliq."command_outbox"
             WHERE "delivered_at" IS NULL
               AND "attempts" < "max_attempts"
             ORDER BY "created_at" ASC
             LIMIT :limit`,
            { replacements: { limit: POLL_BATCH_SIZE }, type: QueryTypes.SELECT },
        );

        if (rows.length === 0) return;

        // Deliver in parallel — multiple entries per daemon are OK.
        await Promise.all(rows.map((entry) => _deliver_entry(entry)));
    } catch (err) {
        log.warn('poll_cycle_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Attempt delivery of a single outbox entry.
 */
async function _deliver_entry(entry: PendingEntry): Promise<void> {
    const sq = get_sequelize();

    // Check backoff: skip if not enough time has elapsed since last attempt.
    //
    // NOTE: `created_at` (BIGINT) and `attempts` (INT) come back from
    // Sequelize as strings unless coerced. Without Number() the '+' below
    // silently string-concatenates and produces an astronomically large
    // "next_eligible" — every retry gets skipped forever. Log-level
    // evidence: entries pinned at attempts=1 with created_at unchanged
    // across many poll cycles.
    const attempts = Number(entry.attempts);
    const created_at = Number(entry.created_at);
    if (attempts > 0) {
        const backoff_ms = BASE_BACKOFF_MS * (2 ** (attempts - 1));
        const next_eligible = created_at + backoff_ms * attempts;
        if (Date.now() < next_eligible) return;
    }

    try {
        const daemon = await Daemon.findByPk(entry.daemon_id);
        if (!daemon?.public_url) {
            // Daemon has no public URL (offline, deregistered, or never
            // registered a URL). Increment attempts so the entry eventually
            // exhausts and gets GC'd. Bump created_at to avoid head-of-line
            // blocking the FIFO batch (see production incident comment below).
            //
            // Without incrementing, orphaned entries for defunct daemons
            // retry indefinitely — generating noise and wasting cycles.
            // A daemon that comes back will re-register and get a fresh
            // public_url; any commands it missed are stale by then anyway.
            await _increment_attempts(entry.tx_id, 'no_public_url');
            log.warn('deliver_skip_no_url', {
                tx_id: entry.tx_id,
                daemon_id: entry.daemon_id,
                attempt: entry.attempts + 1,
                max_attempts: entry.max_attempts,
            });
            return;
        }

        // Build auth header.
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'x-requested-with': 'XMLHttpRequest',
        };
        const auth = await _dispatch_auth_header(daemon);
        if (auth) headers.Authorization = auth;

        const url = `${daemon.public_url}${entry.endpoint}`;

        log.debug('deliver_attempt', {
            tx_id: entry.tx_id,
            daemon_id: entry.daemon_id,
            endpoint: entry.endpoint,
            attempt: entry.attempts + 1,
        });

        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: entry.payload,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (res.ok || (res.status >= 200 && res.status < 300)) {
            // Delivered successfully.
            await sq.query(
                `UPDATE cliq."command_outbox"
                 SET "delivered_at" = :now, "attempts" = "attempts" + 1, "error" = NULL
                 WHERE "tx_id" = :tx_id`,
                { replacements: { tx_id: entry.tx_id, now: Date.now() }, type: QueryTypes.UPDATE },
            );
            log.info('command_delivered', {
                tx_id: entry.tx_id,
                daemon_id: entry.daemon_id,
                endpoint: entry.endpoint,
            });
            // Emit a run-log breadcrumb whenever we pass a run-scoped
            // command off to the daemon. Fixes the "I clicked Resume,
            // is anything happening?" gap — the user sees a marker in
            // the log immediately, no need to open the pending banner.
            void _emit_run_log_delivery(entry).catch(() => {});
            return;
        }

        // Non-2xx: retryable vs. permanent failure.
        const retryable = res.status === 408 || res.status === 429
            || res.status === 401 || res.status >= 500;

        // Read the body once — we need it both for the specific
        // run_not_found orphan-handling below and for the generic
        // error message. `.json()` on failure just falls through to
        // a `HTTP <status>` label.
        let body_text = '';
        let body_json: { error?: unknown; message?: unknown } | null = null;
        try {
            body_text = await res.text();
            body_json = body_text ? JSON.parse(body_text) as typeof body_json : null;
        } catch {
            /* opaque body — fall back to status-only message */
        }

        const error_msg = _extract_error_message(res.status, body_json, body_text);

        // Specialised handling: daemon says "I have no local record
        // of this run" (its ephemeral pod storage was wiped on a
        // restart). Retrying is pointless — the phase records are
        // gone forever on that daemon. Mark the Hub run as orphaned
        // so the UI can steer the user to Run again with the same
        // inputs, then exhaust the outbox entry.
        if (res.status === 404 && _is_run_not_found(body_json)) {
            await _handle_daemon_run_not_found(entry);
            await sq.query(
                `UPDATE cliq."command_outbox"
                 SET "attempts" = "max_attempts", "error" = :error
                 WHERE "tx_id" = :tx_id`,
                { replacements: { tx_id: entry.tx_id, error: error_msg }, type: QueryTypes.UPDATE },
            );
            return;
        }

        if (retryable) {
            await _increment_attempts(entry.tx_id, error_msg);
        } else {
            // Permanent failure — exhaust attempts.
            await sq.query(
                `UPDATE cliq."command_outbox"
                 SET "attempts" = "max_attempts", "error" = :error
                 WHERE "tx_id" = :tx_id`,
                { replacements: { tx_id: entry.tx_id, error: error_msg }, type: QueryTypes.UPDATE },
            );
            log.warn('command_permanent_failure', {
                tx_id: entry.tx_id,
                daemon_id: entry.daemon_id,
                endpoint: entry.endpoint,
                status: res.status,
                error: error_msg,
            });
        }
    } catch (err) {
        // Transport error (fetch failed, timeout, etc.) — retryable.
        const error_msg = err instanceof Error ? err.message : String(err);
        const is_transport = _is_transient_error(err);

        if (is_transport) {
            await _increment_attempts(entry.tx_id, error_msg);
        } else {
            // Unexpected error — increment but log loud.
            await _increment_attempts(entry.tx_id, error_msg);
            log.error('command_deliver_error', {
                tx_id: entry.tx_id,
                daemon_id: entry.daemon_id,
                error: error_msg,
            });
        }
    }
}

/**
 * Increment attempt count, record error, and move to the back of the
 * queue by bumping created_at. This ensures a failing entry doesn't
 * starve newer entries of batch slots.
 */
async function _increment_attempts(tx_id: string, error: string): Promise<void> {
    const sq = get_sequelize();
    await sq.query(
        `UPDATE cliq."command_outbox"
         SET "attempts" = "attempts" + 1, "error" = :error, "created_at" = :now
         WHERE "tx_id" = :tx_id`,
        { replacements: { tx_id, error, now: Date.now() }, type: QueryTypes.UPDATE },
    );
}

/**
 * Move the entry to the tail of the FIFO batch without touching attempts.
 * Used when we deliberately skip (e.g. daemon offline / no public_url):
 * we still want to retry when the daemon reconnects, but not from batch
 * position #1 on every 2s cycle — that starves the rest of the queue.
 */
async function _bump_created_at(tx_id: string): Promise<void> {
    const sq = get_sequelize();
    await sq.query(
        `UPDATE cliq."command_outbox"
         SET "created_at" = :now
         WHERE "tx_id" = :tx_id`,
        { replacements: { tx_id, now: Date.now() }, type: QueryTypes.UPDATE },
    );
}

/**
 * Best-effort: write a single-line breadcrumb into the run's log when
 * the Hub hands a control command off to the daemon. Silently no-ops
 * when the entry doesn't reference a run (workspace-level installs,
 * uninstalls) or when the payload can't be parsed.
 *
 * We import RunService lazily to avoid a startup cycle — command_outbox
 * is a leaf service, RunService depends on many others.
 */
async function _emit_run_log_delivery(entry: PendingEntry): Promise<void> {
    let run_id: string | null = null;
    try {
        const payload = JSON.parse(entry.payload) as { run_id?: unknown };
        if (typeof payload.run_id === 'string' && payload.run_id.trim()) {
            run_id = payload.run_id.trim();
        }
    } catch {
        return;
    }
    if (!run_id) return;

    const label = _endpoint_label_for_log(entry.endpoint);
    if (!label) return;

    const { RunService } = await import('./run.service.js');
    const line = `→ Daemon received ${label} (tx ${entry.tx_id.slice(0, 8)})\n`;
    try {
        // Stamp the breadcrumb with concern:'command' so the Hub run
        // page can hide it behind the "commands" chip and the logs
        // explorer can bucket delivery breadcrumbs separately from
        // run-execution lines.
        await RunService.append_log(run_id, line, { concern: 'command' });
    } catch {
        /* log append is best-effort — never break the delivery worker */
    }
}

/**
 * Human-readable command label for the run-log breadcrumb. Returns
 * null for commands we don't want to surface (e.g. bookkeeping).
 */
function _endpoint_label_for_log(endpoint: string): string | null {
    if (endpoint === '/v1/cancel') return 'Cancel';
    if (endpoint === '/v1/resume') return 'Resume';
    if (endpoint === '/v1/execute') return 'Start';
    if (endpoint === '/v1/runs/supply_inputs') {
        return 'Supply inputs';
    }
    return null;
}

/**
 * Detect the daemon's `run_not_found` response. The daemon returns
 * `{ ok?: false, error: 'run_not_found', message: "Run '…' not found" }`
 * with HTTP 404 from every endpoint that looks up local run state.
 * Matching on both the `error` code AND the message keeps this robust
 * against small shape changes.
 */
function _is_run_not_found(body: { error?: unknown; message?: unknown } | null): boolean {
    if (!body) return false;
    if (typeof body.error === 'string' && body.error === 'run_not_found') return true;
    if (typeof body.message === 'string' && /run\s.*?not found/i.test(body.message)) return true;
    return false;
}

/**
 * Best-effort human message extraction from a non-2xx daemon response.
 * Falls back to `HTTP <status>` when the body is opaque.
 */
function _extract_error_message(
    status: number,
    body_json: { error?: unknown; message?: unknown } | null,
    body_text: string,
): string {
    if (body_json && typeof body_json.message === 'string' && body_json.message.trim()) {
        return `HTTP ${status}: ${body_json.message.trim()}`;
    }
    if (body_json && typeof body_json.error === 'string' && body_json.error.trim()) {
        return `HTTP ${status}: ${body_json.error.trim()}`;
    }
    const snippet = body_text.trim().slice(0, 200);
    if (snippet) return `HTTP ${status}: ${snippet}`;
    return `HTTP ${status}`;
}

/**
 * The daemon told us it doesn't know this run. Its local SQLite has
 * no row (pod restart wiped ephemeral storage). The run is orphaned
 * — no future retry against this or any other daemon can recover it.
 *
 * Actions:
 *   1. Stamp `team_runs.state_lost_at` so the UI shows the honest
 *      "state lost" banner and Run-again quick-action instead of
 *      offering Resume forever.
 *   2. Transition running/awaiting_input runs to `crashed` so the
 *      dashboard's live-run counters agree with reality. Already-
 *      terminal runs (failed/completed/cancelled) keep their state
 *      to preserve history — the state_lost_at flag is enough for
 *      the UI to distinguish.
 *   3. Purge every other queued command targeting this run — they'd
 *      all fail the same way and just create outbox noise.
 *   4. Append a run-log breadcrumb so operators tailing the log see
 *      the transition at the point it happened.
 *
 * Lazy-imports RunService for the same reason as the delivery
 * breadcrumb: outbox is a leaf service.
 */
async function _handle_daemon_run_not_found(entry: PendingEntry): Promise<void> {
    let run_id: string | null = null;
    try {
        const payload = JSON.parse(entry.payload) as { run_id?: unknown };
        if (typeof payload.run_id === 'string' && payload.run_id.trim()) {
            run_id = payload.run_id.trim();
        }
    } catch {
        /* payload not JSON — nothing to orphan */
    }
    if (!run_id) return;

    const sq = get_sequelize();
    const now = Date.now();
    const orphan_msg = 'Daemon lost this run\'s local state on restart. '
        + 'The phase records are no longer available on any daemon. '
        + 'Start a new run with the same inputs.';

    try {
        // One statement handles both cases: state_lost_at is stamped
        // unconditionally; state flips to 'crashed' only for live runs
        // via CASE. `error` is overwritten because the previous error
        // (if any) is stale — the current honest status is "state lost".
        await sq.query(
            `UPDATE cliq."team_runs"
                SET "state_lost_at" = COALESCE("state_lost_at", :now),
                    "state" = CASE
                        WHEN "state" IN ('running', 'awaiting_input') THEN 'crashed'
                        ELSE "state"
                    END,
                    "completed_at" = CASE
                        WHEN "state" IN ('running', 'awaiting_input') THEN :now
                        ELSE "completed_at"
                    END,
                    "error" = :error,
                    "lease_expires_at" = NULL
              WHERE "run_id" = :run_id`,
            {
                replacements: { run_id, now, error: orphan_msg },
                type: QueryTypes.UPDATE,
            },
        );

        // Purge queued commands for this run — every one of them
        // targets the same amnesiac daemon and will fail identically.
        // Mark as superseded rather than deleting so the outbox
        // audit trail stays intact.
        await sq.query(
            `UPDATE cliq."command_outbox"
                SET "attempts" = "max_attempts",
                    "error" = COALESCE("error" || ' | ', '') || 'superseded by orphaned-run detection'
              WHERE "acked_at" IS NULL
                AND "delivered_at" IS NULL
                AND "tx_id" != :tx_id
                AND "payload"::jsonb->>'run_id' = :run_id`,
            {
                replacements: { run_id, tx_id: entry.tx_id },
                type: QueryTypes.UPDATE,
            },
        );

        log.warn('run_state_lost_on_daemon', {
            run_id,
            daemon_id: entry.daemon_id,
            endpoint: entry.endpoint,
            tx_id: entry.tx_id,
        });

        // Breadcrumb into the run's log. Same fire-and-forget
        // pattern as _emit_run_log_delivery.
        try {
            const { RunService } = await import('./run.service.js');
            const label = _endpoint_label_for_log(entry.endpoint) ?? entry.endpoint;
            const line = `⚠ Daemon returned run_not_found for ${label} — `
                + 'run state was lost on daemon restart. '
                + 'Marked as crashed. Use Run again to dispatch a fresh run.\n';
            await RunService.append_log(run_id, line);
        } catch {
            /* log append is best-effort */
        }
    } catch (err) {
        log.error('orphan_mark_failed', {
            run_id,
            daemon_id: entry.daemon_id,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/** Check if an error is a transient transport error. */
function _is_transient_error(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (err.message === 'fetch failed') return true;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    return false;
}

/**
 * Mint a dispatch JWT for the daemon call.
 * Returns null if the daemon has no realm membership.
 */
async function _dispatch_auth_header(daemon: Daemon): Promise<string | null> {
    try {
        const realms = await RealmService.list_realms_for_daemon(daemon.id);
        if (realms.length === 0) return null;
        return DispatchAuthService.authorization_header({
            realm_id: realms[0]!.id,
            aud: daemon.id,
            action: 'access',
        });
    } catch {
        return null;
    }
}

// ── Stale Ack Detection ──────────────────────────────────────────────

/**
 * Sweep command_outbox for entries that were delivered but never acked.
 * Marks them as `ack_status = 'timeout'`.
 */
async function _sweep_stale_acks(): Promise<void> {
    const sq = get_sequelize();
    const now = Date.now();

    try {
        // Execute commands get a longer threshold.
        await sq.query(
            `UPDATE cliq."command_outbox"
             SET "ack_status" = 'timeout'
             WHERE "delivered_at" IS NOT NULL
               AND "acked_at" IS NULL
               AND "ack_status" IS NULL
               AND "endpoint" = '/v1/execute'
               AND "delivered_at" < :threshold`,
            {
                replacements: { threshold: now - STALE_ACK_EXECUTE_THRESHOLD_MS },
                type: QueryTypes.UPDATE,
            },
        );

        // All other commands use the default threshold.
        await sq.query(
            `UPDATE cliq."command_outbox"
             SET "ack_status" = 'timeout'
             WHERE "delivered_at" IS NOT NULL
               AND "acked_at" IS NULL
               AND "ack_status" IS NULL
               AND "endpoint" != '/v1/execute'
               AND "delivered_at" < :threshold`,
            {
                replacements: { threshold: now - STALE_ACK_DEFAULT_THRESHOLD_MS },
                type: QueryTypes.UPDATE,
            },
        );
    } catch (err) {
        log.warn('stale_ack_sweep_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ── Garbage Collection ───────────────────────────────────────────────

/**
 * Delete old entries: delivered + acked/failed older than retention.
 */
async function _gc(): Promise<void> {
    const sq = get_sequelize();
    const threshold = Date.now() - GC_RETAIN_MS;

    try {
        await sq.query(
            `DELETE FROM cliq."command_outbox"
             WHERE "created_at" < :threshold
               AND (
                 "acked_at" IS NOT NULL
                 OR "attempts" >= "max_attempts"
                 OR "ack_status" = 'timeout'
               )`,
            { replacements: { threshold }, type: QueryTypes.DELETE },
        );
    } catch (err) {
        log.warn('command_outbox_gc_error', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ── Lifecycle ────────────────────────────────────────────────────────

/** Start the delivery worker, stale-ack sweeper, and GC timer. */
export function start_command_outbox_worker(): void {
    if (_worker_timer) return;
    _running = true;

    _worker_timer = setInterval(() => {
        _poll_cycle().catch(() => {});
    }, POLL_INTERVAL_MS);

    _gc_timer = setInterval(() => {
        _gc().catch(() => {});
    }, GC_INTERVAL_MS);

    _stale_ack_timer = setInterval(() => {
        _sweep_stale_acks().catch(() => {});
    }, STALE_ACK_INTERVAL_MS);

    log.info('command_outbox_worker_started');
}

/** Stop all timers. */
export function stop_command_outbox_worker(): void {
    _running = false;
    if (_worker_timer) { clearInterval(_worker_timer); _worker_timer = null; }
    if (_gc_timer) { clearInterval(_gc_timer); _gc_timer = null; }
    if (_stale_ack_timer) { clearInterval(_stale_ack_timer); _stale_ack_timer = null; }
}

// ── Observability ────────────────────────────────────────────────────

/** Stats for the Hub health endpoint. */
export async function get_command_outbox_stats(): Promise<{
    command_outbox_pending: number;
    command_outbox_failed: number;
}> {
    const sq = get_sequelize();
    const [pending_rows] = await sq.query(
        `SELECT COUNT(*) as cnt FROM cliq."command_outbox" WHERE "delivered_at" IS NULL AND "attempts" < "max_attempts"`,
    ) as unknown as [Array<{ cnt: string }>];
    const [failed_rows] = await sq.query(
        `SELECT COUNT(*) as cnt FROM cliq."command_outbox" WHERE "delivered_at" IS NULL AND "attempts" >= "max_attempts"`,
    ) as unknown as [Array<{ cnt: string }>];

    return {
        command_outbox_pending: parseInt(pending_rows?.[0]?.cnt ?? '0', 10),
        command_outbox_failed: parseInt(failed_rows?.[0]?.cnt ?? '0', 10),
    };
}

/** Exposed for testing — runs one poll cycle synchronously. */
export async function _test_poll_cycle(): Promise<void> {
    const was_running = _running;
    _running = true;
    try {
        await _poll_cycle();
    } finally {
        _running = was_running;
    }
}
