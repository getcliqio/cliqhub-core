/**
 * Reading a cliqd reply — the daemon's one wire format (cliq-sdk 2.0):
 *
 *   success  `{ ok: true, data }`                               2xx
 *   failure  `{ ok: false, error: { code, message, details? } }` 4xx / 5xx
 *
 * Core sends every daemon route its plain input (no SDK message envelope);
 * the command outbox (`services/command_outbox.service.ts`) and the live
 * reads (`DispatchService.query_daemon`) read the reply through these
 * helpers. A reply relayed by the sync service is the same body with the
 * command's `tx_id` merged in.
 *
 * Pure functions: the daemon's contract tests copy them (keep in sync with
 * `cliq-platform/daemon/tests/spec/contracts/core_wire.spec.ts`) and
 * `tests/unit/lib/daemon_reply.test.ts` runs them on the same fixtures.
 */

/** The daemon error code for a run its local store does not know. */
export const DAEMON_RUN_NOT_FOUND = 'RUN_NOT_FOUND';

/** The `error` object of a daemon failure reply. */
export interface DaemonReplyError {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
}

/** True for a plain (non-array) object. */
function _is_record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The `data` of a success reply, or `undefined` when the body is not one.
 *
 * @param body - Parsed reply body.
 */
export function daemon_reply_data<T = unknown>(body: unknown): T | undefined {
    return _is_record(body) && body.ok === true ? body.data as T : undefined;
}

/**
 * The `error` of a failure reply, or `null` when the body is not one.
 *
 * @param body - Parsed reply body.
 */
export function daemon_reply_error(body: unknown): DaemonReplyError | null {
    if (!_is_record(body) || body.ok !== false || !_is_record(body.error)) return null;
    const { code, message, details } = body.error;
    if (typeof code !== 'string' || typeof message !== 'string') return null;
    return { code, message, ...(details === undefined ? {} : { details }) };
}

/**
 * True when the daemon answered "I have no local record of this run":
 * HTTP 404 with `error.code === 'RUN_NOT_FOUND'`.
 *
 * @param status - HTTP status.
 * @param body - Parsed reply body.
 */
export function is_daemon_run_not_found(status: number, body: unknown): boolean {
    return status === 404 && daemon_reply_error(body)?.code === DAEMON_RUN_NOT_FOUND;
}

/**
 * True when a failed delivery should be retried: request timeout, rate
 * limit, an auth failure (the dispatch key may still be rotating) or a
 * daemon / relay fault (5xx).
 *
 * @param status - HTTP status of a non-2xx reply.
 */
export function is_retryable_daemon_status(status: number): boolean {
    return status === 408 || status === 429 || status === 401 || status >= 500;
}

/**
 * A one-line description of a failed reply for logs and the outbox `error`
 * column: `HTTP <status>: <CODE>: <message>`, or a body snippet when the
 * body is not a daemon failure reply.
 *
 * @param status - HTTP status.
 * @param body - Parsed reply body (`null` when it was not JSON).
 * @param body_text - Raw reply body.
 */
export function daemon_failure_message(status: number, body: unknown, body_text: string): string {
    const error = daemon_reply_error(body);
    if (error) return `HTTP ${status}: ${error.code}: ${error.message}`;
    const snippet = body_text.trim().slice(0, 200);
    return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`;
}
