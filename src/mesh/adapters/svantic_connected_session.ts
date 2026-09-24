/**
 * Svantic connected-mode WebSocket session.
 *
 * Transport is `@svantic/sdk/mesh` WsTransport. Hub only owns dispatch
 * handling → A2aInvokeService (via on_dispatch) and heartbeat ticks.
 */

import { randomUUID } from 'node:crypto';
import {
    WsTransport,
    SDK_VERSION,
    type WebSocketFactory,
    type WsTransportState,
} from '@svantic/sdk/mesh';

export const SVANTIC_WS_SUBPROTOCOL = 'svantic.v1';
export const SVANTIC_HEARTBEAT_MS = 30_000;
export const SVANTIC_WELCOME_TIMEOUT_MS = 10_000;

/** Minimal surface compatible with SDK WebSocketFactory / test doubles. */
export interface I_svantic_socket {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    on(event: 'open', handler: () => void): void;
    on(event: 'message', handler: (data: unknown) => void): void;
    on(event: 'close', handler: (code?: number, reason?: unknown) => void): void;
    on(event: 'error', handler: (err: Error) => void): void;
}

export type Svantic_socket_factory = (
    url: string,
    headers: Record<string, string>,
) => I_svantic_socket;

export type Dispatch_handler = (input: {
    skill_id: string;
    args: Record<string, unknown>;
    session_id?: string;
}) => Promise<unknown>;

export type Session_state = WsTransportState;

export interface Connected_session_options {
    realm_id: string;
    connect_url: string;
    token_provider: () => string;
    instance_id: string;
    agent_type: string;
    agent_version?: string;
    agent_card?: Record<string, unknown>;
    on_dispatch: Dispatch_handler;
    socket_factory?: Svantic_socket_factory;
    welcome_timeout_ms?: number;
    heartbeat_ms?: number;
    auto_reconnect?: boolean;
    reconnect_delays_ms?: readonly number[];
    now_iso?: () => string;
    uuid?: () => string;
    on_state?: (state: Session_state) => void;
}

export class Svantic_connected_session {
    readonly realm_id: string;
    private readonly _on_dispatch: Dispatch_handler;
    private readonly _heartbeat_ms: number;
    private readonly _uuid: () => string;
    private readonly _on_state?: (state: Session_state) => void;
    private readonly _transport: WsTransport;
    private _heartbeat_timer: ReturnType<typeof setInterval> | null = null;
    private _unsub_frame: (() => void) | null = null;
    private _state: Session_state = 'disconnected';

    constructor(opts: Connected_session_options) {
        this.realm_id = opts.realm_id;
        this._on_dispatch = opts.on_dispatch;
        this._heartbeat_ms = opts.heartbeat_ms ?? SVANTIC_HEARTBEAT_MS;
        this._uuid = opts.uuid ?? randomUUID;
        this._on_state = opts.on_state;

        const factory: WebSocketFactory | undefined = opts.socket_factory
            ? (url, headers) => opts.socket_factory!(url, headers)
            : undefined;

        this._transport = new WsTransport({
            connect_url: opts.connect_url,
            token_provider: opts.token_provider,
            hello: {
                instance_id: opts.instance_id,
                agent_type: opts.agent_type,
                agent_version: opts.agent_version ?? '1.0.0',
                sdk_version: SDK_VERSION,
                agent_card: opts.agent_card ?? {},
            },
            welcome_timeout_ms: opts.welcome_timeout_ms ?? SVANTIC_WELCOME_TIMEOUT_MS,
            auto_reconnect: opts.auto_reconnect ?? true,
            ...(opts.reconnect_delays_ms ? { reconnect_delays_ms: opts.reconnect_delays_ms } : {}),
            ...(factory ? { socket_factory: factory } : {}),
            ...(opts.uuid ? { uuid_impl: opts.uuid } : {}),
            ...(opts.now_iso ? { now_iso: opts.now_iso } : {}),
        });
    }

    get state(): Session_state {
        return this._state;
    }

    async connect(): Promise<void> {
        this._unsub_frame?.();
        this._unsub_frame = this._transport.on_frame((frame) => {
            this._set_state(this._transport.state);
            if (frame.type === 'dispatch') {
                void this._handle_dispatch(frame);
            }
        });

        this._set_state('connecting');
        await this._transport.connect();
        this._set_state(this._transport.state);
        this._start_heartbeat();
    }

    async close(): Promise<void> {
        this._stop_heartbeat();
        this._unsub_frame?.();
        this._unsub_frame = null;
        this._set_state('closing');
        await this._transport.close(1000, 'client_close');
        this._set_state(this._transport.state);
    }

    private _set_state(state: Session_state): void {
        if (this._state === state) return;
        this._state = state;
        this._on_state?.(state);
    }

    private async _handle_dispatch(frame: {
        id: string;
        type: string;
        payload: Record<string, unknown>;
    }): Promise<void> {
        if (frame.type !== 'dispatch') return;
        const dispatch_id = frame.id;
        const skill_id = typeof frame.payload.skill_id === 'string' ? frame.payload.skill_id : '';
        if (!skill_id) {
            this._send_error(dispatch_id, 'INVALID_DISPATCH', 'dispatch missing skill_id');
            return;
        }

        const args = (frame.payload.args && typeof frame.payload.args === 'object'
            ? frame.payload.args
            : {}) as Record<string, unknown>;
        const session_ctx = frame.payload.session_context;
        const session_id = session_ctx && typeof session_ctx === 'object'
            && typeof (session_ctx as Record<string, unknown>).session_id === 'string'
            ? String((session_ctx as Record<string, unknown>).session_id)
            : undefined;

        try {
            const result = await this._on_dispatch({ skill_id, args, session_id });
            if (this._transport.state !== 'ready') return;
            this._transport.send({
                v: 1,
                type: 'dispatch_result',
                id: this._uuid(),
                ts: new Date().toISOString(),
                in_reply_to: dispatch_id,
                payload: { result },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this._send_error(dispatch_id, 'HANDLER_ERROR', `capability "${skill_id}" failed: ${msg}`);
        }
    }

    private _send_error(dispatch_id: string, code: string, message: string): void {
        if (this._transport.state !== 'ready' && this._transport.state !== 'authenticating') return;
        try {
            this._transport.send({
                v: 1,
                type: 'error',
                id: this._uuid(),
                ts: new Date().toISOString(),
                in_reply_to: dispatch_id,
                payload: { code, message },
            });
        } catch { /* noop */ }
    }

    private _start_heartbeat(): void {
        this._stop_heartbeat();
        this._heartbeat_timer = setInterval(() => {
            if (this._transport.state !== 'ready') return;
            try {
                this._transport.send({
                    v: 1,
                    type: 'heartbeat',
                    id: this._uuid(),
                    ts: new Date().toISOString(),
                    payload: { status: 'available', current_sessions: 0 },
                });
            } catch { /* reconnect path will heal */ }
        }, this._heartbeat_ms);
        if (typeof this._heartbeat_timer.unref === 'function') {
            this._heartbeat_timer.unref();
        }
    }

    private _stop_heartbeat(): void {
        if (!this._heartbeat_timer) return;
        clearInterval(this._heartbeat_timer);
        this._heartbeat_timer = null;
    }
}
