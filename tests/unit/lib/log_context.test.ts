/** Request log context + error-logging levels. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

import { configure_hub_logging, get_logger, run_with_log_context, current_log_context } from '../../../src/lib/log.js';
import { log_request_error, public_error_message } from '../../../src/middleware/error_logging.js';

const lines: Array<Record<string, any>> = [];
beforeEach(() => {
    lines.length = 0;
    configure_hub_logging('debug');
    for (const m of ['debug', 'info', 'warn', 'error'] as const) {
        vi.spyOn(console, m).mockImplementation((s: string) => { lines.push(JSON.parse(s)); });
    }
});

describe('log context', () => {
    it('adds request_id and user_id to lines written inside a request, including async work', async () => {
        await run_with_log_context({ request_id: 'r-1' }, async () => {
            current_log_context()!.user_id = 'u-9';
            await new Promise((r) => setTimeout(r, 1));
            get_logger('svc.x').info('thing_done', { id: 7 });
        });
        expect(lines[0]).toMatchObject({ level: 'INFO', component: 'svc.x', msg: 'thing_done', ctx: { request_id: 'r-1', user_id: 'u-9', id: 7 } });
    });

    it('lines outside a request carry no request fields', () => {
        get_logger('svc.x').info('boot', { a: 1 });
        expect(lines[0].ctx).toEqual({ a: 1 });
    });

    it('fatal is written as FATAL to stderr', () => {
        get_logger('server').fatal('startup_failed', {});
        expect(lines[0].level).toBe('FATAL');
    });
});

describe('log_request_error', () => {
    const req = { method: 'POST', originalUrl: '/v1/x?y=1', url: '/v1/x' } as Request;
    it.each([
        [500, 'ERROR', 'request_failed'],
        [403, 'WARN', 'access_denied'],
        [401, 'WARN', 'access_denied'],
        [404, 'DEBUG', 'not_found'],
        [422, 'DEBUG', 'request_rejected'],
    ])('%i → %s %s', (status, level, msg) => {
        log_request_error(req, status, new Error('boom'));
        expect(lines[0]).toMatchObject({ level, msg, ctx: { route: 'POST /v1/x', status } });
    });

    it('5xx lines carry the stack; production bodies hide the message', () => {
        log_request_error(req, 500, new Error('db down'));
        expect(lines[0].ctx.error.stack).toContain('db down');
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        expect(public_error_message(new Error('db down'))).toBe('Internal server error');
        process.env.NODE_ENV = prev;
    });
});
