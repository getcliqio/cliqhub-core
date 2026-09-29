import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response, NextFunction } from 'express';
import { DraftsController } from '../../../src/controllers/drafts_controller.js';

function make_drafts_service() {
    return {
        get: vi.fn().mockResolvedValue({ drafts: [] }),
        get_by_id: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1), title: 'Test', team_json: '{}', created_at: '', updated_at: '' }),
        new_draft: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1) }),
        update: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1) }),
        delete_draft: vi.fn().mockResolvedValue({ deleted: true }),
    };
}

function make_req(body: any = {}, auth: any = { user: { id: hub_legacy_uuid(1) }, org_slugs: [], org_ids: [], scopes: [] }): Request {
    return { body, auth } as unknown as Request;
}

function make_res(): Response {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    return res;
}

describe('DraftsController', () => {
    let controller: DraftsController;
    let service: ReturnType<typeof make_drafts_service>;

    beforeEach(() => {
        vi.clearAllMocks();
        service = make_drafts_service();
        controller = new DraftsController(service as any);
    });

    const next = vi.fn() as unknown as NextFunction;

    function call(method: (req: Request, res: Response) => Promise<void>, req: Request, res: Response) {
        return controller.wrap(method)(req, res, next);
    }

    it('get delegates to service', async () => {
        const req = make_req({});
        const res = make_res();
        await call(controller.get, req, res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('get_by_id rejects non-integer id', async () => {
        const req = make_req({ id: 'abc' });
        const res = make_res();
        await call(controller.get_by_id, req, res);
        await new Promise(r => setTimeout(r, 10));
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('get_by_id delegates with valid id', async () => {
        const req = make_req({ id: hub_legacy_uuid(1) });
        const res = make_res();
        await call(controller.get_by_id, req, res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('new_draft rejects missing team_json', async () => {
        const req = make_req({ title: 'Test' });
        const res = make_res();
        await call(controller.new_draft, req, res);
        await new Promise(r => setTimeout(r, 10));
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('new_draft delegates with valid body', async () => {
        const req = make_req({ team_json: '{}' });
        const res = make_res();
        await call(controller.new_draft, req, res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('update rejects missing id', async () => {
        const req = make_req({ team_json: '{}' });
        const res = make_res();
        await call(controller.update, req, res);
        await new Promise(r => setTimeout(r, 10));
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('update rejects missing team_json', async () => {
        const req = make_req({ id: hub_legacy_uuid(1) });
        const res = make_res();
        await call(controller.update, req, res);
        await new Promise(r => setTimeout(r, 10));
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('update delegates with valid body', async () => {
        const req = make_req({ id: hub_legacy_uuid(1), team_json: '{}' });
        const res = make_res();
        await call(controller.update, req, res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('delete_draft rejects non-integer id', async () => {
        const req = make_req({ id: 'abc' });
        const res = make_res();
        await call(controller.delete_draft, req, res);
        await new Promise(r => setTimeout(r, 10));
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('delete_draft delegates with valid id', async () => {
        const req = make_req({ id: hub_legacy_uuid(1) });
        const res = make_res();
        await call(controller.delete_draft, req, res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });
});
