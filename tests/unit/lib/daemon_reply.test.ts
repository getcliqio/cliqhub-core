/**
 * Core's reading of cliqd replies (`src/lib/daemon_reply.ts`) on the shared
 * wire fixture `tests/fixtures/daemon_wire/daemon_replies.json`.
 *
 * The fixture is a copy of cliq-platform
 * `daemon/tests/fixtures/wire/daemon_replies.json` (keep in sync); the
 * daemon pins it against its real replies and runs a copy of these
 * functions on them (`daemon/tests/spec/contracts/core_wire.spec.ts`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    DAEMON_RUN_NOT_FOUND,
    daemon_failure_message,
    daemon_reply_data,
    daemon_reply_error,
    is_daemon_run_not_found,
    is_retryable_daemon_status,
} from '../../../src/lib/daemon_reply.js';

/** One pinned reply and what Core concludes from it. */
interface Scenario {
    request: { path: string; body: Record<string, unknown> };
    status: number;
    exact?: boolean;
    body: unknown;
    core?: { delivered: boolean; retryable: boolean; run_not_found: boolean; error_msg: string };
}

const WIRE = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../fixtures/daemon_wire/daemon_replies.json', import.meta.url)),
    'utf8',
)) as Record<'outbox' | 'query' | 'agents', Record<string, Scenario>>;

/** Core's outbox decision for one reply, as `command_outbox.service.ts` `_deliver` makes it. */
function outbox_reads(status: number, text: string) {
    if (status >= 200 && status < 300) return { delivered: true, retryable: false, run_not_found: false, error_msg: '' };
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* opaque body: the snippet message */ }
    return {
        delivered: false,
        retryable: is_retryable_daemon_status(status),
        run_not_found: is_daemon_run_not_found(status, body),
        error_msg: daemon_failure_message(status, body, text),
    };
}

describe('command outbox ← cliqd replies (fixture)', () => {
    for (const [name, scenario] of Object.entries(WIRE.outbox)) {
        it(name, () => {
            expect(outbox_reads(scenario.status, JSON.stringify(scenario.body))).toEqual(scenario.core);
        });
    }

    it('only a 404 RUN_NOT_FOUND is "run state lost"', () => {
        const body = WIRE.outbox.supply_inputs_unknown_run!.body;
        expect(is_daemon_run_not_found(404, body)).toBe(true);
        expect(is_daemon_run_not_found(500, body)).toBe(false);
        expect(is_daemon_run_not_found(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Run x not found' } })).toBe(false);
        expect(is_daemon_run_not_found(404, { error: 'run_not_found', message: "Run 'x' not found" })).toBe(false);
        expect(DAEMON_RUN_NOT_FOUND).toBe('RUN_NOT_FOUND');
    });

    it('retries on 408 / 429 / 401 / 5xx only', () => {
        expect([408, 429, 401, 500, 502, 503].every(is_retryable_daemon_status)).toBe(true);
        expect([400, 403, 404, 409, 422].some(is_retryable_daemon_status)).toBe(false);
    });

    it('describes a body that is not a daemon reply by a snippet', () => {
        expect(daemon_failure_message(502, null, '<html>bad gateway</html>')).toBe('HTTP 502: <html>bad gateway</html>');
        expect(daemon_failure_message(500, null, '')).toBe('HTTP 500');
        expect(daemon_failure_message(400, { type: 'error', payload: { code: 'X' } }, '{"type":"error"}')).toBe('HTTP 400: {"type":"error"}');
    });
});

describe('query_daemon ← cliqd replies (fixture)', () => {
    it('teams_get: data.teams[] with the fields the live cache stores', () => {
        const data = daemon_reply_data<{ teams: Array<Record<string, unknown>> }>(WIRE.query.teams_get!.body)!;
        for (const key of ['team_id', 'scope', 'slug', 'version', 'manifest', 'created_at']) expect(data.teams[0]).toHaveProperty(key);
    });

    it('workspaces_get: data.workspaces[] with id and dir', () => {
        const data = daemon_reply_data<{ workspaces: Array<Record<string, unknown>> }>(WIRE.query.workspaces_get!.body)!;
        expect(data.workspaces[0]).toHaveProperty('workspace_id');
        expect(data.workspaces[0]).toHaveProperty('workspace_dir');
    });

    it('teams_get_invalid: no data; the error carries code and message', () => {
        const scenario = WIRE.query.teams_get_invalid!;
        expect(daemon_reply_data(scenario.body)).toBeUndefined();
        expect(daemon_reply_error(scenario.body)).toMatchObject({ code: 'PAYLOAD_INVALID' });
        expect(daemon_failure_message(scenario.status, scenario.body, JSON.stringify(scenario.body))).toBe(scenario.core!.error_msg);
    });

    it('a pre-2.0 SDK envelope is not read as data', () => {
        expect(daemon_reply_data({ type: 'ok', payload: { data: { teams: [] } } })).toBeUndefined();
        expect(daemon_reply_error({ type: 'error', payload: { code: 'X', message: 'y' } })).toBeNull();
    });
});
