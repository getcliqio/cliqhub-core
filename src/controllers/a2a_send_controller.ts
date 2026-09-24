import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/api_error.js';
import { RealmA2aService } from '../services/realm_a2a.service.js';
import { A2aInvokeService } from '../services/a2a_invoke.service.js';
import type { A2a_task } from '../services/a2a_invoke.service.js';

const rpc_schema = z.object({
    jsonrpc: z.literal('2.0').optional(),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().min(1),
    params: z.record(z.unknown()).optional(),
});

function bearer_from_req(req: Request): string | undefined {
    const header = req.headers.authorization;
    return typeof header === 'string' ? header : undefined;
}

async function resolve_realm_for_slug(
    slug: string,
    req: Request,
    opts?: { org_id?: string },
): Promise<{
    realm_id: string;
    slug: string;
}> {
    const { realm_id } = await RealmA2aService.authorize_send({
        slug,
        org_id: opts?.org_id,
        authorization_header: bearer_from_req(req),
        body: req.body,
        headers: req.headers as Record<string, string | string[] | undefined>,
    });
    return { realm_id, slug };
}

function extract_skill_and_inputs(params: Record<string, unknown> | undefined): {
    skill_id: string;
    inputs: Record<string, unknown>;
    context_id?: string;
} {
    const message = (params?.message && typeof params.message === 'object')
        ? params.message as Record<string, unknown>
        : {};
    const metadata = (message.metadata && typeof message.metadata === 'object')
        ? message.metadata as Record<string, unknown>
        : {};

    let skill_id = '';
    let inputs: Record<string, unknown> = {};

    if (typeof metadata.skill_id === 'string') skill_id = metadata.skill_id;
    if (typeof metadata.skillId === 'string' && !skill_id) skill_id = metadata.skillId;
    if (metadata.inputs && typeof metadata.inputs === 'object') {
        inputs = metadata.inputs as Record<string, unknown>;
    }

    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        if (p.kind !== 'data' || !p.data || typeof p.data !== 'object') continue;
        const data = p.data as Record<string, unknown>;
        if (typeof data.skill_id === 'string') skill_id = data.skill_id;
        if (typeof data.skillId === 'string' && !skill_id) skill_id = data.skillId;
        if (typeof data.capability === 'string' && !skill_id) skill_id = data.capability;
        if (data.inputs && typeof data.inputs === 'object') {
            inputs = data.inputs as Record<string, unknown>;
        }
        if (data.args && typeof data.args === 'object' && Object.keys(inputs).length === 0) {
            inputs = data.args as Record<string, unknown>;
        }
    }

    if (typeof params?.skill_id === 'string' && !skill_id) {
        skill_id = params.skill_id;
    }
    if (params?.inputs && typeof params.inputs === 'object') {
        inputs = params.inputs as Record<string, unknown>;
    }

    if (!skill_id.trim()) {
        throw ApiError.bad_request(
            'skill_id required (message.metadata.skill_id or data part)',
        );
    }

    const context_id = typeof message.contextId === 'string'
        ? message.contextId
        : (typeof params?.contextId === 'string' ? params.contextId : undefined);

    return { skill_id: skill_id.trim(), inputs, context_id };
}

function rpc_result(id: unknown, result: unknown) {
    return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpc_error(id: unknown, code: number, message: string) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wait_for_terminal(
    task_id: string,
    realm_id: string,
    opts: { timeout_ms: number; poll_ms: number },
): Promise<A2a_task> {
    const deadline = Date.now() + opts.timeout_ms;
    let task = await A2aInvokeService.get_task(task_id, realm_id);
    while (
        task.status.state === 'working'
        || task.status.state === 'submitted'
    ) {
        if (Date.now() >= deadline) return task;
        await sleep(opts.poll_ms);
        task = await A2aInvokeService.get_task(task_id, realm_id);
    }
    return task;
}

function write_sse(res: Response, event: unknown): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export class A2aSendController {
    static async send(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const slug = String(req.params.slug ?? '').trim();
            const org_slug = String(req.params.org ?? '').trim();

            // Resolve org_id from the URL org slug for org-scoped lookup.
            let org_id: string | undefined;
            if (org_slug) {
                const { Org } = await import('../db/models/index.js');
                const org = await Org.findOne({ where: { slug: org_slug } });
                if (org) org_id = org.id;
            }

            const { realm_id } = await resolve_realm_for_slug(slug, req, { org_id });

            const body = rpc_schema.parse(req.body ?? {});
            const method = body.method;
            const params = (body.params ?? {}) as Record<string, unknown>;

            if (method === 'tasks/get') {
                const task_id = typeof params.id === 'string'
                    ? params.id
                    : (typeof params.taskId === 'string' ? params.taskId : '');
                if (!task_id) {
                    res.status(400).json(rpc_error(body.id, -32602, 'tasks/get requires id'));
                    return;
                }
                const task = await A2aInvokeService.get_task(task_id, realm_id);
                res.json(rpc_result(body.id, task));
                return;
            }

            if (method === 'message/send') {
                const extracted = extract_skill_and_inputs(params);
                const task = await A2aInvokeService.invoke_skill({
                    realm_id,
                    skill_id: extracted.skill_id,
                    inputs: extracted.inputs,
                    context_id: extracted.context_id,
                });
                res.json(rpc_result(body.id, task));
                return;
            }

            if (method === 'message/stream') {
                const extracted = extract_skill_and_inputs(params);
                const accepted = await A2aInvokeService.invoke_skill({
                    realm_id,
                    skill_id: extracted.skill_id,
                    inputs: extracted.inputs,
                    context_id: extracted.context_id,
                });

                res.status(200);
                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache, no-transform');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders?.();

                write_sse(res, rpc_result(body.id, accepted));

                const terminal = await wait_for_terminal(accepted.id, realm_id, {
                    timeout_ms: 10 * 60 * 1000,
                    poll_ms: 1500,
                });

                if (terminal.status.state !== accepted.status.state
                    || terminal.artifacts
                    || terminal.status.message) {
                    write_sse(res, {
                        jsonrpc: '2.0',
                        id: body.id ?? null,
                        result: {
                            kind: 'status-update',
                            taskId: terminal.id,
                            status: terminal.status,
                            final: terminal.status.state === 'completed'
                                || terminal.status.state === 'failed'
                                || terminal.status.state === 'canceled',
                        },
                    });
                }

                if (terminal.artifacts) {
                    write_sse(res, {
                        jsonrpc: '2.0',
                        id: body.id ?? null,
                        result: {
                            kind: 'artifact-update',
                            taskId: terminal.id,
                            artifacts: terminal.artifacts,
                        },
                    });
                }

                write_sse(res, rpc_result(body.id, terminal));
                res.end();
                return;
            }

            res.status(400).json(
                rpc_error(body.id, -32601, `Method not found: ${method}`),
            );
        } catch (err) {
            if (res.headersSent) {
                next(err);
                return;
            }
            if (err instanceof ApiError) {
                const rpc_code = err.status_code === 401 || err.status_code === 403
                    ? -32001
                    : -32000;
                res.status(err.status_code).json(
                    rpc_error(
                        (req.body && typeof req.body === 'object' && 'id' in req.body)
                            ? (req.body as { id?: unknown }).id
                            : null,
                        rpc_code,
                        err.message,
                    ),
                );
                return;
            }
            next(err);
        }
    }
}
