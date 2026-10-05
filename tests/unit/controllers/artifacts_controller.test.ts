/**
 * Unit tests for ArtifactsController — validates Zod parsing,
 * delegation to ArtifactStorageService, and response shaping.
 *
 * The storage service is fully mocked; tests verify the controller
 * correctly parses bodies, delegates, and calls `this.ok(res, data)`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    download_url: 'https://r2.example.com/signed',
    created_at: 1700000000000,
};

const FAKE_SUBMIT_RESULT = {
    artifact_id: 'art-001',
    name: 'report.md',
    download_url: 'https://r2.example.com/signed',
    size_bytes: 42,
};

describe('ArtifactsController', () => {
    let controller: ArtifactsController;
    let next: NextFunction;

    const mock_storage = {
        submit: vi.fn().mockResolvedValue(FAKE_SUBMIT_RESULT),
        get: vi.fn().mockResolvedValue([FAKE_ARTIFACT]),
        get_by_id: vi.fn().mockResolvedValue(FAKE_ARTIFACT),
        delete: vi.fn().mockResolvedValue(true),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new ArtifactsController(mock_storage as any);
        next = vi.fn();
    });

    // ── submit ───────────────────────────────────────────────────────

    describe('submit', () => {
        it('delegates to service and responds 201', async () => {
            const res = mock_res();
            const handler = controller.wrap(controller.submit);
            await handler(
                make_req({ run_id: 'run-1', phase: 'analyst', name: 'report.md', content: 'hello' }),
                res,
                next,
            );

            expect(mock_storage.submit).toHaveBeenCalledWith(
                expect.objectContaining({ run_id: 'run-1', phase: 'analyst', name: 'report.md' }),
                'u-1',
            );
            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith({ ok: true, data: FAKE_SUBMIT_RESULT });
        });

        it('rejects missing required fields with 422', async () => {
            const res = mock_res();
            const handler = controller.wrap(controller.submit);
            await handler(make_req({ run_id: 'run-1' }), res, next);

            // Validation error is forwarded via next().
            expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
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
