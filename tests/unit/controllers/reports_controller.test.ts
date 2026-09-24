import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response, NextFunction } from 'express';
import { ReportsController } from '../../../src/controllers/reports_controller.js';

function mock_res() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

const fake_auth = { user: { id: hub_legacy_uuid(1) }, org_slugs: [], org_ids: [], scopes: [] };

const mock_service = {
    audit: vi.fn().mockResolvedValue({ entries: [], total: 0, limit: 50, offset: 0 }),
};

function make_req(body: Record<string, unknown> = {}, auth = fake_auth) {
    return { body, auth } as unknown as Request;
}

describe('ReportsController', () => {
    let controller: ReportsController;
    const next = vi.fn() as unknown as NextFunction;

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new ReportsController(mock_service as any);
    });

    it('audit accepts empty body and delegates to service', async () => {
        const res = mock_res();
        await controller.audit(make_req(), res, next);
        expect(mock_service.audit).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('audit rejects limit > 100 with 422', async () => {
        const res = mock_res();
        await controller.audit(make_req({ limit: 200 }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('audit passes with valid action filter', async () => {
        const res = mock_res();
        await controller.audit(make_req({ action: 'create' }), res, next);
        expect(mock_service.audit).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('audit passes with valid target_type filter', async () => {
        const res = mock_res();
        await controller.audit(make_req({ target_type: 'team' }), res, next);
        expect(mock_service.audit).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('audit passes with admin_id filter', async () => {
        const res = mock_res();
        await controller.audit(make_req({ admin_id: hub_legacy_uuid(3) }), res, next);
        expect(mock_service.audit).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('audit rejects negative offset with 422', async () => {
        const res = mock_res();
        await controller.audit(make_req({ offset: -5 }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('audit rejects non-integer admin_id with 422', async () => {
        const res = mock_res();
        await controller.audit(make_req({ admin_id: 'abc' }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });
});
