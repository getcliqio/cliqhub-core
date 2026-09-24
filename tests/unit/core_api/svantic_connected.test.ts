import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
    Svantic_connected_session,
    type I_svantic_socket,
    type Svantic_socket_factory,
} from '../../../src/mesh/adapters/svantic_connected_session.js';
import { svantic_connected_pool } from '../../../src/mesh/adapters/svantic_connected_pool.js';
import { svantic_mesh_adapter } from '../../../src/mesh/adapters/svantic.adapter.js';

vi.mock('../../../src/mesh/adapters/svantic_client.js', async (import_original) => {
    const actual = await import_original<typeof import('../../../src/mesh/adapters/svantic_client.js')>();
    return {
        ...actual,
        svantic_http: {
            get_token: vi.fn(async () => 'tok'),
            register: vi.fn(async () => ({
                ok: true as const,
                deployment_mode: 'connected' as const,
                connect_url: 'wss://mesh.test/agents/connect',
                instance_id: 'cliq-realm-r1',
            })),
            deregister: vi.fn(async () => undefined),
        },
    };
});

import { svantic_http } from '../../../src/mesh/adapters/svantic_client.js';

class Mock_socket extends EventEmitter implements I_svantic_socket {
    readyState = 0;
    sent: string[] = [];
    auto_welcome = false;

    send(data: string): void {
        this.sent.push(data);
        if (!this.auto_welcome) return;
        try {
            const frame = JSON.parse(data) as { type?: string };
            if (frame.type !== 'hello') return;
            queueMicrotask(() => {
                this.push_json({
                    v: 1,
                    type: 'welcome',
                    id: 'w-auto',
                    ts: new Date().toISOString(),
                    payload: { resumed: false, server_time: new Date().toISOString() },
                });
            });
        } catch { /* ignore */ }
    }

    close(): void {
        this.readyState = 3;
        this.emit('close', 1000, 'closed');
    }

    open_now(): void {
        this.readyState = 1;
        this.emit('open');
    }

    push_json(frame: unknown): void {
        this.emit('message', JSON.stringify(frame));
    }
}

function make_factory(
    sockets: Mock_socket[],
    opts: { auto_welcome?: boolean } = {},
): Svantic_socket_factory {
    return () => {
        const sock = new Mock_socket();
        sock.auto_welcome = opts.auto_welcome ?? false;
        sockets.push(sock);
        queueMicrotask(() => sock.open_now());
        return sock;
    };
}

describe('Svantic_connected_session', () => {
    it('hello → welcome → ready, then dispatch → dispatch_result', async () => {
        const sockets: Mock_socket[] = [];
        const on_dispatch = vi.fn(async () => ({ ok: true, echo: 1 }));

        const session = new Svantic_connected_session({
            realm_id: 'r1',
            connect_url: 'wss://mesh.test/agents/connect',
            token_provider: () => 'tok',
            instance_id: 'cliq-realm-r1',
            agent_type: 'cliq-realm',
            agent_card: { name: 'test' },
            on_dispatch,
            socket_factory: make_factory(sockets),
            auto_reconnect: false,
        });

        const connect_p = session.connect();
        await vi.waitFor(() => expect(sockets[0]?.sent.length).toBeGreaterThan(0));

        const hello = JSON.parse(sockets[0]!.sent[0]!);
        expect(hello.type).toBe('hello');
        expect(hello.payload.instance_id).toBe('cliq-realm-r1');

        sockets[0]!.push_json({
            v: 1,
            type: 'welcome',
            id: 'w1',
            ts: new Date().toISOString(),
            payload: { resumed: false, server_time: new Date().toISOString() },
        });
        await connect_p;
        expect(session.state).toBe('ready');

        sockets[0]!.push_json({
            v: 1,
            type: 'dispatch',
            id: 'd1',
            ts: new Date().toISOString(),
            payload: {
                skill_id: 'notify_member',
                args: { member_id: 'u1', message: 'hi' },
                session_context: { session_id: 's1' },
            },
        });

        await vi.waitFor(() => {
            const result_frames = sockets[0]!.sent
                .map((s) => JSON.parse(s) as { type: string; in_reply_to?: string; payload: unknown })
                .filter((f) => f.type === 'dispatch_result');
            expect(result_frames.length).toBe(1);
            expect(result_frames[0]!.in_reply_to).toBe('d1');
            expect(result_frames[0]!.payload).toEqual({ result: { ok: true, echo: 1 } });
        });

        expect(on_dispatch).toHaveBeenCalledWith({
            skill_id: 'notify_member',
            args: { member_id: 'u1', message: 'hi' },
            session_id: 's1',
        });

        await session.close();
        expect(session.state).toBe('closed');
    });

    it('dispatch handler failure sends error frame', async () => {
        const sockets: Mock_socket[] = [];
        const session = new Svantic_connected_session({
            realm_id: 'r1',
            connect_url: 'wss://mesh.test/agents/connect',
            token_provider: () => 'tok',
            instance_id: 'cliq-realm-r1',
            agent_type: 'cliq-realm',
            on_dispatch: async () => {
                throw new Error('boom');
            },
            socket_factory: make_factory(sockets),
            auto_reconnect: false,
        });

        const connect_p = session.connect();
        await vi.waitFor(() => expect(sockets[0]?.readyState).toBe(1));
        sockets[0]!.push_json({
            v: 1,
            type: 'welcome',
            id: 'w1',
            ts: new Date().toISOString(),
            payload: { resumed: false, server_time: new Date().toISOString() },
        });
        await connect_p;

        sockets[0]!.push_json({
            v: 1,
            type: 'dispatch',
            id: 'd2',
            ts: new Date().toISOString(),
            payload: { skill_id: 'acme/bot', args: {} },
        });

        await vi.waitFor(() => {
            const errors = sockets[0]!.sent
                .map((s) => JSON.parse(s) as { type: string; payload: { code?: string } })
                .filter((f) => f.type === 'error');
            expect(errors.length).toBe(1);
            expect(errors[0]!.payload.code).toBe('HANDLER_ERROR');
        });

        await session.close();
    });
});

describe('svantic adapter connected mode', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await svantic_connected_pool.reset_for_tests();
        (svantic_http.register as ReturnType<typeof vi.fn>).mockResolvedValue({
            ok: true,
            deployment_mode: 'connected',
            connect_url: 'wss://mesh.test/agents/connect',
            instance_id: 'cliq-realm-r1',
        });
    });

    afterEach(async () => {
        await svantic_connected_pool.reset_for_tests();
    });

    it('connect opens WS pool and health reports ready', async () => {
        const sockets: Mock_socket[] = [];
        const entry = await svantic_connected_pool.start({
            realm_id: 'r1',
            api_url: 'https://api.svantic.com',
            client_id: 'cid',
            client_secret: 'csec',
            agent_type: 'cliq-realm',
            agent_card: { name: 'r1' },
            socket_factory: make_factory(sockets, { auto_welcome: true }),
            on_dispatch: async () => ({ ok: true }),
            auto_reconnect: false,
        });

        expect(entry.session.state).toBe('ready');
        expect(svantic_http.register).toHaveBeenCalledWith(
            expect.objectContaining({ deployment_mode: 'connected', instance_id: 'cliq-realm-r1' }),
        );
        expect(svantic_connected_pool.is_ready('r1')).toBe(true);

        const health = await svantic_mesh_adapter.health({
            realm_id: 'r1',
            realm_slug: 'acme',
            public_a2a_url: 'https://api.cliqhub.io/a2a/r/acme',
            settings: {
                mode: 'connected',
                client_id: 'cid',
                client_secret: 'csec',
            },
        });
        expect(health.status).toBe('connected');
        expect(health.details?.ws_state).toBe('ready');

        await svantic_connected_pool.stop('r1');
        expect(svantic_connected_pool.is_ready('r1')).toBe(false);
    });
});
