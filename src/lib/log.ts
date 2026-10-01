/**
 * Hub backend structured logger (stdout NDJSON).
 *
 * Levels gated by `CLIQ_HUB_LOG_LEVEL` or `LOG_LEVEL` (default `info`).
 *
 * Which level to use:
 *   debug — decisions and detail (access_allowed, service entry with ids, timings)
 *   info  — something changed or someone signed in (run_created, role_changed, token_minted)
 *   warn  — refused or unexpected but handled (access_denied + reason, deprecated path, retry)
 *   error — the request failed on our side (5xx, DB / R2 / mesh failure)
 *   fatal — Core cannot start or continue; log, then exit(1)
 * Never log tokens, passwords, secrets, setting values or request bodies.
 * Shape aligns with the unified logging contract:
 *   { ts, level, component, msg, ctx? }
 *
 * Call style (both supported):
 *   log.info('event_name', { queue_item_id })
 *   log.info(`human message ${id}`)
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request fields added to every log line written while serving that
 * request (set by `request_logging_middleware`, filled in after the token is
 * read). Lets service logs be tied to a request without passing ids around.
 */
export interface LogContext {
    request_id?: string;
    user_id?: string;
    auth_via?: string;
}

const _log_context = new AsyncLocalStorage<LogContext>();

/** Run `fn` with `ctx` attached to every log line it (and its async work) writes. */
export function run_with_log_context<T>(ctx: LogContext, fn: () => T): T {
    return _log_context.run(ctx, fn);
}

/** The current request's log context (mutable: later middleware adds user_id). */
export function current_log_context(): LogContext | undefined {
    return _log_context.getStore();
}

export type HubLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface CoreLogger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    /** Core cannot start or continue. Log, then the caller exits the process. */
    fatal(...args: unknown[]): void;
}

const LEVEL_RANK: Record<HubLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    fatal: 50,
};

function normalize_level(raw: string | undefined): HubLogLevel {
    if (!raw?.trim()) return 'info';
    const lower = raw.trim().toLowerCase();
    if (lower === 'debug' || lower === 'info' || lower === 'warn' || lower === 'error' || lower === 'fatal') {
        return lower;
    }
    if (lower === 'warning') return 'warn';
    return 'info';
}

function resolve_process_level(): HubLogLevel {
    if (process.env.VITEST) return 'error';
    return normalize_level(
        process.env.CLIQ_HUB_LOG_LEVEL ?? process.env.LOG_LEVEL,
    );
}

let process_level = resolve_process_level();

/** Re-read env (tests / hot reload). */
export function configure_hub_logging(level?: string): void {
    process_level = level !== undefined
        ? normalize_level(level)
        : resolve_process_level();
}

export function get_hub_log_level(): HubLogLevel {
    return process_level;
}

function format_ctx_value(value: unknown): unknown {
    if (value instanceof Error) {
        return { name: value.name, message: value.message };
    }
    return value;
}

function split_args(args: unknown[]): { msg: string; ctx?: Record<string, unknown> } {
    if (args.length === 0) return { msg: '' };

    const first = args[0];
    if (typeof first === 'string' && args.length === 1) {
        return { msg: first };
    }

    if (typeof first === 'string' && args.length >= 2) {
        const rest = args.slice(1);
        if (
            rest.length === 1
            && rest[0] !== null
            && typeof rest[0] === 'object'
            && !(rest[0] instanceof Error)
            && !Array.isArray(rest[0])
        ) {
            return { msg: first, ctx: rest[0] as Record<string, unknown> };
        }

        const ctx: Record<string, unknown> = {};
        const parts: string[] = [first];
        rest.forEach((arg, index) => {
            if (arg instanceof Error) {
                ctx[`error_${index}`] = format_ctx_value(arg);
                return;
            }
            if (arg !== null && typeof arg === 'object') {
                ctx[`arg_${index}`] = arg;
                return;
            }
            parts.push(String(arg));
        });
        return Object.keys(ctx).length > 0
            ? { msg: parts.join(' '), ctx }
            : { msg: parts.join(' ') };
    }

    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
        return { msg: 'log', ctx: first as Record<string, unknown> };
    }

    return { msg: args.map(String).join(' ') };
}

function emit(level: HubLogLevel, component: string, args: unknown[]): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[process_level]) return;

    const { msg, ctx: own_ctx } = split_args(args);
    // Request context first; the call's own fields win on conflict.
    const req_ctx = _log_context.getStore();
    const ctx = req_ctx && (req_ctx.request_id || req_ctx.user_id)
        ? {
            ...(req_ctx.request_id ? { request_id: req_ctx.request_id } : {}),
            ...(req_ctx.user_id ? { user_id: req_ctx.user_id } : {}),
            ...(req_ctx.auth_via ? { auth_via: req_ctx.auth_via } : {}),
            ...(own_ctx ?? {}),
        }
        : own_ctx;
    const line: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level: level.toUpperCase(),
        component,
        msg,
    };
    if (ctx && Object.keys(ctx).length > 0) {
        line.ctx = ctx;
    }

    const serialized = JSON.stringify(line);
    if (level === 'error' || level === 'fatal') {
        console.error(serialized);
        return;
    }
    if (level === 'warn') {
        console.warn(serialized);
        return;
    }
    if (level === 'debug') {
        console.debug(serialized);
        return;
    }
    console.info(serialized);
}

export function get_logger(category: string): CoreLogger {
    return {
        debug: (...args) => emit('debug', category, args),
        info: (...args) => emit('info', category, args),
        warn: (...args) => emit('warn', category, args),
        error: (...args) => emit('error', category, args),
        fatal: (...args) => emit('fatal', category, args),
    };
}

export function shutdown_logging(): void {
    /* no-op — console logger has no resources to release */
}
