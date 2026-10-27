/**
 * Unit tests for ArtifactsController — validates Zod parsing,
 * delegation to ArtifactStorageService, and response shaping.
 *
 * The storage service is fully mocked; tests verify the controller
 * correctly parses bodies, delegates, and calls `this.ok(res, data)`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { Request, Response, NextFunction } from 'express';
import { ArtifactsController } from '../../../src/controllers/artifacts_controller.js';

/** Minimal mock response with status + json chainable. */
function mock_res() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

/** Build a fake Express request with the given body. */
function make_req(body: Record<string, unknown> = {}, user?: Record<string, unknown>) {
    const auth_user = user ?? { id: 'u-1' };
    return {
        body,
        auth: { user: auth_user, org_ids: [], org_slugs: [], scopes: [] },
        headers: { 'content-type': 'application/json' },
    } as unknown as Request;
}

/** Fake artifact data returned by the mock service. */
const FAKE_ARTIFACT = {
    artifact_id: 'art-001',
    run_id: 'run-1',
    phase: 'analyst',
    name: 'report.md',
    description: null,
    mime_type: 'text/markdown',
    size_bytes: 42,
    download_url: 'https://api.cliqhub.io/v1/artifacts/download?artifact_id=art-001',
    created_at: 1700000000000,
};

const FAKE_UPLOAD_RESULT = {
    artifact_id: 'art-001',
    name: 'report.md',
    size: 42,
    content_type: 'text/markdown',
    sha256: 'abc',
    status: 'ready',
    download_url: 'https://api.cliqhub.io/v1/artifacts/download?artifact_id=art-001',
};

describe('ArtifactsController', () => {
    let controller: ArtifactsController;
    let next: NextFunction;

    const mock_storage = {
        upload: vi.fn().mockResolvedValue(FAKE_UPLOAD_RESULT),
        get: vi.fn().mockResolvedValue([FAKE_ARTIFACT]),
        get_by_id: vi.fn().mockResolvedValue(FAKE_ARTIFACT),
        delete: vi.fn().mockResolvedValue(true),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new ArtifactsController(mock_storage as any);
        next = vi.fn();
    });

    // ── upload ───────────────────────────────────────────────────────

    describe('upload', () => {
        it('streams the raw body to the service as a daemon run artifact and responds 201', async () => {
            const res = mock_res();
            const req = {
                query: { run_id: 'run-1', phase: 'analyst', name: 'report.md' },
                headers: { 'content-type': 'text/markdown', 'content-length': '42' },
                auth: { auth_via: 'daemon_token', realm_id: 'realm-1' },
            } as unknown as Request;
            await controller.wrap(controller.upload)(req, res, next);
            expect(mock_storage.upload).toHaveBeenCalledWith(expect.objectContaining({
                stream: req, content_length: 42, content_type: 'text/markdown', name: 'report.md',
                target: { kind: 'run', run_id: 'run-1', phase: 'analyst' }, uploaded_by: null,
            }));
            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith({ ok: true, data: FAKE_UPLOAD_RESULT });
        });

        it('refuses a missing Content-Length (411) and a bad query (422)', async () => {
            await controller.wrap(controller.upload)({ query: { run_id: 'r', phase: 'p', name: 'n' }, headers: {}, auth: {} } as unknown as Request, mock_res(), next);
            expect(next).toHaveBeenLastCalledWith(expect.objectContaining({ status: 411 }));
            await controller.wrap(controller.upload)({ query: { name: 'n' }, headers: { 'content-length': '1' }, auth: {} } as unknown as Request, mock_res(), next);
            expect(next).toHaveBeenLastCalledWith(expect.objectContaining({ status: 422 }));
            expect(mock_storage.upload).not.toHaveBeenCalled();
        });
    });

    // ── download ─────────────────────────────────────────────────────

    describe('download', () => {
        /** A writable response that records headers and collects the body. */
        function file_res() {
            const sink = new PassThrough();
            const headers: Record<string, string> = {};
            const chunks: Buffer[] = [];
            sink.on('data', (c: Buffer) => chunks.push(c));
            Object.assign(sink, { status: vi.fn().mockReturnThis(), setHeader: (k: string, v: string) => { headers[k] = v; } });
            return { res: sink as unknown as Response, headers, body: () => Buffer.concat(chunks).toString() };
        }
        const stored = (content_length: number | null) => ({
            body: new Response('Hi Ada').body, status: 200, content_length, content_type: 'text/plain', name: 'review.txt', mime_type: 'text/plain',
        });

        it('streams the file with its length', async () => {
            (mock_storage as any).download = vi.fn().mockResolvedValue(stored(6));
            const out = file_res();
            await controller.wrap(controller.download)({ method: 'GET', query: { artifact_id: 'a-1' }, headers: {}, auth: { user: { id: 'u-1' } } } as unknown as Request, out.res, next);
            expect(out.headers['Content-Length']).toBe('6');
            expect(out.body()).toBe('Hi Ada');
        });

        it('a length storage did not report is left off — never Content-Length: 0 on a file that has bytes', async () => {
            (mock_storage as any).download = vi.fn().mockResolvedValue(stored(null));
            const out = file_res();
            await controller.wrap(controller.download)({ method: 'GET', query: { artifact_id: 'a-1' }, headers: {}, auth: { user: { id: 'u-1' } } } as unknown as Request, out.res, next);
            expect(out.headers).not.toHaveProperty('Content-Length');
            expect(out.body()).toBe('Hi Ada');
        });
    });

    // ── get ──────────────────────────────────────────────────────────

    describe('get', () => {
        it('lists artifacts for a run', async () => {
            const res = mock_res();
            const handler = controller.wrap(controller.get);
            await handler(make_req({ run_id: 'run-1' }), res, next);

            expect(mock_storage.get).toHaveBeenCalledWith('run-1', undefined, false);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ ok: true, data: [FAKE_ARTIFACT] });
        });

        it('passes phase filter', async () => {
            const res = mock_res();
            const handler = controller.wrap(controller.get);
            await handler(make_req({ run_id: 'run-1', phase: 'builder' }), res, next);

            expect(mock_storage.get).toHaveBeenCalledWith('run-1', 'builder', false);
        });

        it('rejects missing run_id', async () => {
            const res = mock_res();
            const handler = controller.wrap(controller.get);
            await handler(make_req({}), res, next);

            expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
        });
    });

    // ── get_by_id ────────────────────────────────────────────────────

    describe('get_by_id', () => {
        it('returns single artifact', async () => {
            const res = mock_res();
            const handler = controller.wrap(controller.get_by_id);
            await handler(make_req({ artifact_id: 'art-001' }), res, next);

            expect(mock_storage.get_by_id).toHaveBeenCalledWith('art-001');
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ ok: true, data: FAKE_ARTIFACT });
        });

        it('rejects missing artifact_id', async () => {
            const res = mock_res();
            const handler = controller.wrap(controller.get_by_id);
            await handler(make_req({}), res, next);

            expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
        });
    });

    // ── delete ───────────────────────────────────────────────────────

    describe('delete', () => {
        it('deletes and returns true', async () => {
            const res = mock_res();
            const handler = controller.wrap(controller.delete);
            await handler(make_req({ artifact_id: 'art-001' }), res, next);

            expect(mock_storage.delete).toHaveBeenCalledWith('art-001');
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ ok: true, data: true });
        });

        it('rejects missing artifact_id', async () => {
            const res = mock_res();
            const handler = controller.wrap(controller.delete);
            await handler(make_req({}), res, next);

            expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
        });
    });
});
