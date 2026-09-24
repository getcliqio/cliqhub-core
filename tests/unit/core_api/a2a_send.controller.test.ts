import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../../src/models/index.js', () => ({}));

vi.mock('../../../src/services/realm_a2a.service.js', () => ({
    RealmA2aService: {
        authorize_send: vi.fn(),
    },
}));

vi.mock('../../../src/services/a2a_invoke.service.js', () => ({
    A2aInvokeService: {
        invoke_skill: vi.fn(),
        get_task: vi.fn(),
    },
}));

vi.mock('../../../src/lib/api_error.js', () => {
    class ApiError extends Error {
        status_code: number;
        constructor(status_code: number, message: string) {
            super(message);
            this.status_code = status_code;
        }
        static unauthorized(msg: string) { return new ApiError(401, msg); }
        static forbidden(msg: string) { return new ApiError(403, msg); }
        static not_found(msg: string) { return new ApiError(404, msg); }
        static bad_request(msg: string) { return new ApiError(400, msg); }
    }
    return { ApiError };
});

import { A2aSendController } from '../../../src/controllers/a2a_send_controller.js';
import { RealmA2aService } from '../../../src/services/realm_a2a.service.js';
import { A2aInvokeService } from '../../../src/services/a2a_invoke.service.js';
import { ApiError } from '../../../src/lib/api_error.js';

function mock_req(body: unknown, opts: { slug?: string; auth?: string } = {}): Request {
    return {
        params: { slug: opts.slug ?? 'acme' },
        headers: { authorization: opts.auth ?? 'Bearer cliq_a2a_test' },
        body,
    } as unknown as Request;
}

function mock_res() {
    const res = {
        status_code: 200,
        body: null as unknown,
        headers_map: {} as Record<string, string>,
        headersSent: false,
        status(code: number) {
            this.status_code = code;
            return this;
        },
        setHeader(k: string, v: string) {
            this.headers_map[k] = v;
            return this;
        },
        flushHeaders() {},
        write(_chunk: string) {},
        end() {
            this.headersSent = true;
        },
        json(body: unknown) {
            this.body = body;
            return this;
        },
    };
    return res as unknown as Response & {
        status_code: number;
        body: unknown;
        headers_map: Record<string, string>;
    };
}

describe('A2aSendController', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(RealmA2aService.authorize_send).mockResolvedValue({ realm_id: 'r1' });
    });

    it('rejects missing bearer with 401', async () => {
        vi.mocked(RealmA2aService.authorize_send).mockRejectedValue(
            ApiError.unauthorized('Bearer token required'),
        );
        const res = mock_res();
        await A2aSendController.send(
            mock_req({ method: 'message/send' }, { auth: '' }),
            res,
            vi.fn() as NextFunction,
        );
        expect(res.status_code).toBe(401);
    });

    it('message/send invokes skill and returns task', async () => {
        vi.mocked(A2aInvokeService.invoke_skill).mockResolvedValue({
            id: 'q1',
            status: { state: 'working' },
            metadata: {
                realm_id: 'r1',
                skill_id: 'cliq/hello-world',
                queue_item_id: 'q1',
                run_id: null,
            },
        } as any);

        const res = mock_res();
        await A2aSendController.send(
            mock_req({
                jsonrpc: '2.0',
                id: '1',
                method: 'message/send',
                params: {
                    message: {
                        metadata: {
                            skill_id: 'cliq/hello-world',
                            inputs: { message: 'hi' },
                        },
                        parts: [],
                    },
                },
            }),
            res,
            vi.fn() as NextFunction,
        );

        expect(A2aInvokeService.invoke_skill).toHaveBeenCalledWith({
            realm_id: 'r1',
            skill_id: 'cliq/hello-world',
            inputs: { message: 'hi' },
            context_id: undefined,
        });
        expect(res.body).toMatchObject({
            jsonrpc: '2.0',
            id: '1',
            result: { id: 'q1' },
        });
    });

    it('tasks/get returns task', async () => {
        vi.mocked(A2aInvokeService.get_task).mockResolvedValue({
            id: 'q1',
            status: { state: 'completed' },
            metadata: {
                realm_id: 'r1',
                skill_id: 'cliq/hello-world',
                queue_item_id: 'q1',
                run_id: 'run-1',
            },
        } as any);

        const res = mock_res();
        await A2aSendController.send(
            mock_req({
                jsonrpc: '2.0',
                id: '2',
                method: 'tasks/get',
                params: { id: 'q1' },
            }),
            res,
            vi.fn() as NextFunction,
        );

        expect(A2aInvokeService.get_task).toHaveBeenCalledWith('q1', 'r1');
        expect(res.body).toMatchObject({
            result: { id: 'q1', status: { state: 'completed' } },
        });
    });

    it('message/stream sets SSE content type', async () => {
        vi.mocked(A2aInvokeService.invoke_skill).mockResolvedValue({
            id: 'q1',
            status: { state: 'completed' },
            metadata: {
                realm_id: 'r1',
                skill_id: 'cliq/hello-world',
                queue_item_id: 'q1',
                run_id: null,
            },
        } as any);
        vi.mocked(A2aInvokeService.get_task).mockResolvedValue({
            id: 'q1',
            status: { state: 'completed' },
            metadata: {
                realm_id: 'r1',
                skill_id: 'cliq/hello-world',
                queue_item_id: 'q1',
                run_id: null,
            },
            artifacts: [{ name: 'result', parts: [{ kind: 'data', data: [] }] }],
        } as any);

        const chunks: string[] = [];
        const res = mock_res();
        (res as any).write = (chunk: string) => { chunks.push(chunk); };

        await A2aSendController.send(
            mock_req({
                jsonrpc: '2.0',
                id: '3',
                method: 'message/stream',
                params: {
                    message: {
                        metadata: { skill_id: 'cliq/hello-world', inputs: { message: 'hi' } },
                        parts: [],
                    },
                },
            }),
            res,
            vi.fn() as NextFunction,
        );

        expect(res.headers_map['Content-Type']).toContain('text/event-stream');
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0]).toContain('data:');
    });
});
