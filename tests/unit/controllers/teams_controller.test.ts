import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response, NextFunction } from 'express';
import { TeamsController } from '../../../src/controllers/teams_controller.js';

function mock_res() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

const fake_auth = { user: { id: hub_legacy_uuid(1) }, org_slugs: [], org_ids: [], scopes: [] };

const mock_service = {
    get: vi.fn().mockResolvedValue({ teams: [], tag_map: new Map(), total: 0, limit: 50, offset: 0 }),
    get_by_id: vi.fn().mockResolvedValue({ name: 'test', scope: null }),
    get_versions: vi.fn().mockResolvedValue({ versions: [] }),
    create: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1), status: 'draft' }),
    update: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1), version: '0.1.1' }),
    publish: vi.fn().mockResolvedValue({ ok: true }),
    unpublish: vi.fn().mockResolvedValue({ status: 'draft', listed: false }),
    download: vi.fn().mockResolvedValue({ data_base64: 'abc' }),
    delete_team: vi.fn().mockResolvedValue({ deleted: true }),
    delete_version: vi.fn().mockResolvedValue({ deleted: true }),
    rename_team: vi.fn().mockResolvedValue({ renamed: true }),
};

function make_req(body: Record<string, unknown> = {}, auth = fake_auth) {
    return { body, auth } as unknown as Request;
}

describe('TeamsController', () => {
    let controller: TeamsController;
    const next = vi.fn() as unknown as NextFunction;

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new TeamsController(mock_service as any);
    });

    // --- get ---

    it('get accepts empty body and delegates to service', async () => {
        const res = mock_res();
        await controller.get(make_req(), res, next);
        expect(mock_service.get).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get rejects limit > 200 with 422', async () => {
        const res = mock_res();
        await controller.get(make_req({ limit: 201 }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('get rejects negative offset with 422', async () => {
        const res = mock_res();
        await controller.get(make_req({ offset: -1 }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- get_by_id ---

    it('get_by_id passes with valid name', async () => {
        const res = mock_res();
        await controller.get_by_id(make_req({ name: 'my-team' }), res, next);
        expect(mock_service.get_by_id).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get_by_id rejects missing name with 422', async () => {
        const res = mock_res();
        await controller.get_by_id(make_req(), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('get_by_id passes with name and version', async () => {
        const res = mock_res();
        await controller.get_by_id(make_req({ name: 'team', version: '1.0.0' }), res, next);
        expect(mock_service.get_by_id).toHaveBeenCalledWith(
            fake_auth,
            expect.objectContaining({ name: 'team', version: '1.0.0' }),
        );
        expect(res.status).toHaveBeenCalledWith(200);
    });

    // --- get_versions ---

    it('get_versions passes with valid name', async () => {
        const res = mock_res();
        await controller.get_versions(make_req({ name: 'team' }), res, next);
        expect(mock_service.get_versions).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get_versions rejects missing name with 422', async () => {
        const res = mock_res();
        await controller.get_versions(make_req(), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- create ---

    it('create passes with name and scope', async () => {
        const res = mock_res();
        await controller.create(make_req({ name: 'team', scope: 'alice' }), res, next);
        expect(mock_service.create).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('create rejects missing scope with 422', async () => {
        const res = mock_res();
        await controller.create(make_req({ name: 'team' }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- update ---

    it('update passes with name', async () => {
        const res = mock_res();
        await controller.update(make_req({ name: 'team', description: 'x' }), res, next);
        expect(mock_service.update).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('update rejects missing name and team_id with 422', async () => {
        const res = mock_res();
        await controller.update(make_req({ description: 'x' }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- publish ---

    it('publish passes with name and data_base64', async () => {
        const res = mock_res();
        await controller.publish(make_req({ name: 'team', data_base64: 'dGVhbQ==' }), res, next);
        expect(mock_service.publish).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('publish allows status-only republish without data_base64', async () => {
        const res = mock_res();
        await controller.publish(make_req({ name: 'team', visibility: 'public' }), res, next);
        expect(mock_service.publish).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    // --- unpublish ---

    it('unpublish passes with name', async () => {
        const res = mock_res();
        await controller.unpublish(make_req({ name: 'team' }), res, next);
        expect(mock_service.unpublish).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('unpublish rejects missing name and team_id with 422', async () => {
        const res = mock_res();
        await controller.unpublish(make_req(), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- download ---

    it('download passes with valid name', async () => {
        const res = mock_res();
        await controller.download(make_req({ name: 'team' }), res, next);
        expect(mock_service.download).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    // --- delete_team ---

    it('delete_team passes with name', async () => {
        const res = mock_res();
        await controller.delete_team(make_req({ name: 'team' }), res, next);
        expect(mock_service.delete_team).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('delete_team rejects missing name and team_id with 422', async () => {
        const res = mock_res();
        await controller.delete_team(make_req(), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- delete_version ---

    it('delete_version passes with name and version', async () => {
        const res = mock_res();
        await controller.delete_version(make_req({ name: 'team', version: '1.0.0' }), res, next);
        expect(mock_service.delete_version).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    // --- rename ---

    it('rename passes with name, scope, new_name', async () => {
        const res = mock_res();
        await controller.rename(make_req({ name: 'old', scope: 'org', new_name: 'fresh' }), res, next);
        expect(mock_service.rename_team).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });
});
