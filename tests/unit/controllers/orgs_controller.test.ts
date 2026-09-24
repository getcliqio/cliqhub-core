import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response, NextFunction } from 'express';
import { OrgsController } from '../../../src/controllers/orgs_controller.js';

vi.mock('../../../src/services/org_role_service.js', () => ({
    OrgRoleService: {
        list: vi.fn().mockResolvedValue([{ id: hub_legacy_uuid(1), slug: 'admin', name: 'Admin' }]),
        get: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(2), slug: 'member', name: 'Member' }),
        create: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(10), slug: 'custom', name: 'Custom' }),
        update: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(10), slug: 'custom', name: 'Custom Updated' }),
        delete: vi.fn().mockResolvedValue({ deleted: true }),
    },
}));

import { OrgRoleService } from '../../../src/services/org_role_service.js';

function mock_res() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

const fake_auth = { user: { id: hub_legacy_uuid(1), role: 'admin' }, org_slugs: [], org_ids: [], scopes: [] };

const mock_service = {
    get: vi.fn().mockResolvedValue({ orgs: [] }),
    get_by_id: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1), slug: 'acme' }),
    new_org: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1), slug: 'acme' }),
    update: vi.fn().mockResolvedValue({ updated: true }),
    delete_org: vi.fn().mockResolvedValue({ deleted: true }),
    add_member: vi.fn().mockResolvedValue({ user_id: hub_legacy_uuid(5), username: 'charlie', role: 'member' }),
    remove_member: vi.fn().mockResolvedValue({ removed: true }),
    assert_org_member_or_admin: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue({ left: true }),
    new_scope: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(10), slug: 'acme-dev' }),
    delete_scope: vi.fn().mockResolvedValue({ deleted: true }),
    assign_scope_member: vi.fn().mockResolvedValue({ assigned: true }),
    unassign_scope_member: vi.fn().mockResolvedValue({ removed: true }),
};

function make_req(body: Record<string, unknown> = {}, auth = fake_auth) {
    return { body, auth } as unknown as Request;
}

describe('OrgsController', () => {
    let controller: OrgsController;
    const next = vi.fn() as unknown as NextFunction;

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new OrgsController(mock_service as any);
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

    it('get rejects negative offset with 422', async () => {
        const res = mock_res();
        await controller.get(make_req({ offset: -1 }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- get_by_id ---

    it('get_by_id passes with valid org_id', async () => {
        const res = mock_res();
        await controller.get_by_id(make_req({ org_id: hub_legacy_uuid(1) }), res, next);
        expect(mock_service.get_by_id).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get_by_id rejects non-integer org_id with 422', async () => {
        const res = mock_res();
        await controller.get_by_id(make_req({ org_id: 'abc' }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- new_org ---

    it('new_org passes with required fields', async () => {
        const res = mock_res();
        await controller.new_org(make_req({ slug: 'acme', admin_username: 'alice' }), res, next);
        expect(mock_service.new_org).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('new_org rejects missing slug with 422', async () => {
        const res = mock_res();
        await controller.new_org(make_req({ admin_username: 'alice' }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- update ---

    it('update passes with org_id and display_name', async () => {
        const res = mock_res();
        await controller.update(make_req({ org_id: hub_legacy_uuid(1), display_name: 'Acme Inc' }), res, next);
        expect(mock_service.update).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('update rejects missing display_name with 422', async () => {
        const res = mock_res();
        await controller.update(make_req({ org_id: hub_legacy_uuid(1) }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- delete_org ---

    it('delete_org passes with valid org_id', async () => {
        const res = mock_res();
        await controller.delete_org(make_req({ org_id: hub_legacy_uuid(1) }), res, next);
        expect(mock_service.delete_org).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('delete_org rejects non-integer org_id with 422', async () => {
        const res = mock_res();
        await controller.delete_org(make_req({ org_id: 'bad' }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- add_member ---

    it('add_member passes with org_id and username', async () => {
        const res = mock_res();
        await controller.add_member(make_req({ org_id: hub_legacy_uuid(1), username: 'charlie' }), res, next);
        expect(mock_service.add_member).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('add_member rejects missing username with 422', async () => {
        const res = mock_res();
        await controller.add_member(make_req({ org_id: hub_legacy_uuid(1) }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- remove_member ---

    it('remove_member passes with org_id and user_id', async () => {
        const res = mock_res();
        await controller.remove_member(make_req({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2) }), res, next);
        expect(mock_service.remove_member).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    // --- list_roles / get_role / create_role / update_role / delete_role ---

    it('list_roles passes with valid org_id', async () => {
        const res = mock_res();
        await controller.list_roles(make_req({ org_id: hub_legacy_uuid(1) }), res, next);
        expect(mock_service.assert_org_member_or_admin).toHaveBeenCalled();
        expect(OrgRoleService.list).toHaveBeenCalledWith(hub_legacy_uuid(1));
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('list_roles rejects missing org_id with 422', async () => {
        const res = mock_res();
        await controller.list_roles(make_req({}), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('get_role passes with org_id and role_id', async () => {
        const res = mock_res();
        await controller.get_role(make_req({ org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(2) }), res, next);
        expect(OrgRoleService.get).toHaveBeenCalledWith(hub_legacy_uuid(1), hub_legacy_uuid(2));
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get_role rejects missing role_id with 422', async () => {
        const res = mock_res();
        await controller.get_role(make_req({ org_id: hub_legacy_uuid(1) }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('create_role passes with required fields', async () => {
        const res = mock_res();
        await controller.create_role(
            make_req({ org_id: hub_legacy_uuid(1), slug: 'custom', name: 'Custom', permissions: ['org.settings'] }),
            res, next,
        );
        expect(OrgRoleService.create).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('create_role rejects missing slug with 422', async () => {
        const res = mock_res();
        await controller.create_role(
            make_req({ org_id: hub_legacy_uuid(1), name: 'Custom', permissions: [] }),
            res, next,
        );
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('update_role passes with name', async () => {
        const res = mock_res();
        await controller.update_role(
            make_req({ org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(10), name: 'Renamed' }),
            res, next,
        );
        expect(OrgRoleService.update).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('update_role rejects when neither name nor permissions provided with 422', async () => {
        const res = mock_res();
        await controller.update_role(make_req({ org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(10) }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('delete_role passes with org_id and role_id', async () => {
        const res = mock_res();
        await controller.delete_role(make_req({ org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(10) }), res, next);
        expect(OrgRoleService.delete).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('delete_role rejects missing role_id with 422', async () => {
        const res = mock_res();
        await controller.delete_role(make_req({ org_id: hub_legacy_uuid(1) }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- leave ---

    it('leave passes with valid org_id', async () => {
        const res = mock_res();
        await controller.leave(make_req({ org_id: hub_legacy_uuid(1) }), res, next);
        expect(mock_service.leave).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('leave rejects non-integer org_id with 422', async () => {
        const res = mock_res();
        await controller.leave(make_req({ org_id: 'bad' }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- new_scope ---

    it('new_scope passes with org_id and slug', async () => {
        const res = mock_res();
        await controller.new_scope(make_req({ org_id: hub_legacy_uuid(1), slug: 'dev' }), res, next);
        expect(mock_service.new_scope).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('new_scope rejects missing slug with 422', async () => {
        const res = mock_res();
        await controller.new_scope(make_req({ org_id: hub_legacy_uuid(1) }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- delete_scope ---

    it('delete_scope passes with org_id and scope_id', async () => {
        const res = mock_res();
        await controller.delete_scope(make_req({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(5) }), res, next);
        expect(mock_service.delete_scope).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    // --- assign_scope_member ---

    it('assign_scope_member passes with all ids', async () => {
        const res = mock_res();
        await controller.assign_scope_member(make_req({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(5), user_id: hub_legacy_uuid(3) }), res, next);
        expect(mock_service.assign_scope_member).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('assign_scope_member rejects missing user_id with 422', async () => {
        const res = mock_res();
        await controller.assign_scope_member(make_req({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(5) }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- unassign_scope_member ---

    it('unassign_scope_member passes with all ids', async () => {
        const res = mock_res();
        await controller.unassign_scope_member(make_req({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(5), user_id: hub_legacy_uuid(3) }), res, next);
        expect(mock_service.unassign_scope_member).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('unassign_scope_member rejects missing scope_id with 422', async () => {
        const res = mock_res();
        await controller.unassign_scope_member(make_req({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(3) }), res, next);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });
});
