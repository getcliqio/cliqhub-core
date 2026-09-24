import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response, NextFunction } from 'express';
import { ScopesController } from '../../../src/controllers/scopes_controller.js';

function mock_res() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

const fake_auth = { user: { id: hub_legacy_uuid(1) }, org_slugs: [], org_ids: [], scopes: [] };

const mock_service = {
    get: vi.fn().mockResolvedValue({ scopes: [], total: 0, limit: 50, offset: 0 }),
    new_scope: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1), slug: 'my-scope' }),
    update: vi.fn().mockResolvedValue({ updated: true }),
    delete_scope: vi.fn().mockResolvedValue({ deleted: true }),
};

function make_req(body: Record<string, unknown> = {}, auth = fake_auth) {
    return { body, auth } as unknown as Request;
}

describe('ScopesController', () => {
    let controller: ScopesController;
    const next = vi.fn() as unknown as NextFunction;

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new ScopesController(mock_service as any);
    });

    // --- get ---

    it('get accepts empty body and delegates to service', async () => {
        const res = mock_res();
        await controller.get(make_req(), res, next);
        expect(mock_service.get).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get rejects limit > 100 with 422', async () => {
        const res = mock_res();
        await controller.get(make_req({ limit: 200 }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('get passes with valid search string', async () => {
        const res = mock_res();
        await controller.get(make_req({ search: 'my-scope' }), res, next);
        expect(mock_service.get).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get rejects negative offset with 422', async () => {
        const res = mock_res();
        await controller.get(make_req({ offset: -1 }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- new_scope ---

    it('new_scope passes with slug and owner_username', async () => {
        const res = mock_res();
        await controller.new_scope(make_req({ slug: 'dev', owner_username: 'alice' }), res, next);
        expect(mock_service.new_scope).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(201);
    });

    it('new_scope rejects missing slug with 422', async () => {
        const res = mock_res();
        await controller.new_scope(make_req({ owner_username: 'alice' }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('new_scope allows omitting owner_username (defaults to caller for org create)', async () => {
        const res = mock_res();
        await controller.new_scope(make_req({ slug: 'dev', org_id: hub_legacy_uuid(1), scope_type: 'org' }), res, next);
        expect(mock_service.new_scope).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(201);
    });

    it('new_scope passes with optional visibility', async () => {
        const res = mock_res();
        await controller.new_scope(make_req({ slug: 'dev', owner_username: 'alice', visibility: 'private' }), res, next);
        expect(mock_service.new_scope).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(201);
    });

    // --- update ---

    it('update passes with valid scope_id', async () => {
        const res = mock_res();
        await controller.update(make_req({ scope_id: hub_legacy_uuid(1), display_name: 'New Name' }), res, next);
        expect(mock_service.update).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('update rejects missing scope_id with 422', async () => {
        const res = mock_res();
        await controller.update(make_req({ display_name: 'New Name' }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- delete_scope ---

    it('delete_scope passes with valid scope_id', async () => {
        const res = mock_res();
        await controller.delete_scope(make_req({ scope_id: hub_legacy_uuid(5) }), res, next);
        expect(mock_service.delete_scope).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('delete_scope rejects non-integer scope_id with 422', async () => {
        const res = mock_res();
        await controller.delete_scope(make_req({ scope_id: 'bad' }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });
});
