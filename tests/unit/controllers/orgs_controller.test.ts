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
    leave: vi.fn().mockResolvedValue({ left: true }),
    new_scope: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(10), slug: 'acme-dev' }),
    delete_scope: vi.fn().mockResolvedValue({ deleted: true }),
    assign_scope_member: vi.fn().mockResolvedValue({ assigned: true }),
    unassign_scope_member: vi.fn().mockResolvedValue({ removed: true }),
    get_reviewable_targets: vi.fn().mockResolvedValue({ targets: [] }),
};

const mock_scopes_service = {
    update: vi.fn().mockResolvedValue({ updated: true }),
    get_for_user: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 }),
    list_catalog: vi.fn().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 }),
};

function make_req(body: Record<string, unknown> = {}, auth = fake_auth) {
    return { body, auth } as unknown as Request;
}

describe('OrgsController', () => {
    let controller: OrgsController;
    const next = vi.fn() as unknown as NextFunction;

    /** Call a controller method through wrap() so errors reach next() correctly. */
    function call(method: (req: Request, res: Response) => Promise<void>, req: Request, res: Response) {
        return controller.wrap(method)(req, res, next);
    }

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new OrgsController(mock_service as any, mock_scopes_service as any);
    });

    // --- get ---

    it('get accepts empty body and delegates to service', async () => {
        const res = mock_res();
        await call(controller.get, make_req(), res);
        expect(mock_service.get).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get rejects limit > 100 with 422', async () => {
        const res = mock_res();
        await call(controller.get, make_req({ limit: 200 }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('get rejects negative offset with 422', async () => {
        const res = mock_res();
        await call(controller.get, make_req({ offset: -1 }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- get_by_id ---

    it('get_by_id passes with valid org_id', async () => {
        const res = mock_res();
        await call(controller.get_by_id, make_req({ org_id: hub_legacy_uuid(1) }), res);
        expect(mock_service.get_by_id).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get_by_id rejects non-uuid org_id with 422', async () => {
        const res = mock_res();
        await call(controller.get_by_id, make_req({ org_id: 'abc' }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- new_org ---

    it('new_org passes with required fields', async () => {
        const res = mock_res();
        await call(controller.new_org, make_req({ slug: 'acme', admin_username: 'alice' }), res);
        expect(mock_service.new_org).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('new_org rejects missing slug with 422', async () => {
        const res = mock_res();
        await call(controller.new_org, make_req({ admin_username: 'alice' }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status_code: 422 }));
    });

    it('new_org rejects missing admin_username with 422', async () => {
        const res = mock_res();
        await call(controller.new_org, make_req({ slug: 'acme' }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status_code: 422 }));
    });

    // --- update ---

    it('update passes with org_id and display_name', async () => {
        const res = mock_res();
        await call(controller.update, make_req({ org_id: hub_legacy_uuid(1), display_name: 'Acme Inc' }), res);
        expect(mock_service.update).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('update rejects missing org_id with 422', async () => {
        const res = mock_res();
        await call(controller.update, make_req({ display_name: 'Acme Inc' }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status_code: 422 }));
    });

    it('update rejects missing display_name with 422', async () => {
        const res = mock_res();
        await call(controller.update, make_req({ org_id: hub_legacy_uuid(1) }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status_code: 422 }));
    });

    // --- delete_org ---

    it('delete_org passes with valid org_id', async () => {
        const res = mock_res();
        await call(controller.delete_org, make_req({ org_id: hub_legacy_uuid(1) }), res);
        expect(mock_service.delete_org).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('delete_org rejects non-uuid org_id with 422', async () => {
        const res = mock_res();
        await call(controller.delete_org, make_req({ org_id: 'bad' }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- add_member ---

    it('add_member passes with org_id and username', async () => {
        const res = mock_res();
        await call(controller.add_member, make_req({ org_id: hub_legacy_uuid(1), username: 'charlie' }), res);
        expect(mock_service.add_member).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('add_member rejects missing username/email/user_id with 422', async () => {
        const res = mock_res();
        await call(controller.add_member, make_req({ org_id: hub_legacy_uuid(1) }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- remove_member ---

    it('remove_member passes with org_id and user_id', async () => {
        const res = mock_res();
        await call(controller.remove_member, make_req({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2) }), res);
        expect(mock_service.remove_member).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    // --- list_roles / get_role / create_role / update_role / delete_role ---

    it('list_roles passes with valid org_id', async () => {
        const res = mock_res();
        await call(controller.list_roles, make_req({ org_id: hub_legacy_uuid(1) }), res);
        expect(OrgRoleService.list).toHaveBeenCalledWith(hub_legacy_uuid(1));
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('list_roles rejects missing org_id with 422', async () => {
        const res = mock_res();
        await call(controller.list_roles, make_req({}), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('get_role passes with org_id and role_id', async () => {
        const res = mock_res();
        await call(controller.get_role, make_req({ org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(2) }), res);
        expect(OrgRoleService.get).toHaveBeenCalledWith(hub_legacy_uuid(1), hub_legacy_uuid(2));
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get_role rejects missing role_id with 422', async () => {
        const res = mock_res();
        await call(controller.get_role, make_req({ org_id: hub_legacy_uuid(1) }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    it('create_role passes with required fields', async () => {
        const res = mock_res();
        await call(
            controller.create_role,
            make_req({ org_id: hub_legacy_uuid(1), slug: 'custom', name: 'Custom', permissions: ['org.settings'] }),
            res,
        );
        expect(OrgRoleService.create).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('create_role rejects missing slug with 422', async () => {
        const res = mock_res();
        await call(
            controller.create_role,
            make_req({ org_id: hub_legacy_uuid(1), name: 'Custom', permissions: [] }),
            res,
        );
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status_code: 422 }));
    });

    it('update_role passes with name', async () => {
        const res = mock_res();
        await call(
            controller.update_role,
            make_req({ org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(10), name: 'Renamed' }),
            res,
        );
        expect(OrgRoleService.update).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('update_role rejects when neither name nor permissions provided with 422', async () => {
        const res = mock_res();
        await call(controller.update_role, make_req({ org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(10) }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status_code: 422 }));
    });

    it('delete_role passes with org_id and role_id', async () => {
        const res = mock_res();
        await call(controller.delete_role, make_req({ org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(10) }), res);
        expect(OrgRoleService.delete).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('delete_role rejects missing role_id with 422', async () => {
        const res = mock_res();
        await call(controller.delete_role, make_req({ org_id: hub_legacy_uuid(1) }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- leave ---

    it('leave passes with valid org_id', async () => {
        const res = mock_res();
        await call(controller.leave, make_req({ org_id: hub_legacy_uuid(1) }), res);
        expect(mock_service.leave).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('leave rejects non-uuid org_id with 422', async () => {
        const res = mock_res();
        await call(controller.leave, make_req({ org_id: 'bad' }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- new_scope ---

    it('new_scope passes with org_id and slug', async () => {
        const res = mock_res();
        await call(controller.new_scope, make_req({ org_id: hub_legacy_uuid(1), slug: 'dev' }), res);
        expect(mock_service.new_scope).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('new_scope rejects missing slug with 422', async () => {
        const res = mock_res();
        await call(controller.new_scope, make_req({ org_id: hub_legacy_uuid(1) }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status_code: 422 }));
    });

    // --- update_scope ---

    it('update_scope passes with scope_id and display_name', async () => {
        const res = mock_res();
        await call(controller.update_scope, make_req({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(5), display_name: 'Dev Tools' }), res);
        expect(mock_scopes_service.update).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('update_scope rejects missing scope_id with 422', async () => {
        const res = mock_res();
        await call(controller.update_scope, make_req({ org_id: hub_legacy_uuid(1), display_name: 'Dev' }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status_code: 422 }));
    });

    it('update_scope rejects no changed fields with 422', async () => {
        const res = mock_res();
        await call(controller.update_scope, make_req({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(5) }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status_code: 422 }));
    });

    // --- delete_scope ---

    it('delete_scope passes with org_id and scope_id', async () => {
        const res = mock_res();
        await call(controller.delete_scope, make_req({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(5) }), res);
        expect(mock_service.delete_scope).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('delete_scope rejects missing scope_id with 422', async () => {
        const res = mock_res();
        await call(controller.delete_scope, make_req({ org_id: hub_legacy_uuid(1) }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status_code: 422 }));
    });

    // --- assign_scope_member ---

    it('assign_scope_member passes with all ids', async () => {
        const res = mock_res();
        await call(controller.assign_scope_member, make_req({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(5), user_id: hub_legacy_uuid(3) }), res);
        expect(mock_service.assign_scope_member).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('assign_scope_member rejects missing user_id with 422', async () => {
        const res = mock_res();
        await call(controller.assign_scope_member, make_req({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(5) }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- unassign_scope_member ---

    it('unassign_scope_member passes with all ids', async () => {
        const res = mock_res();
        await call(controller.unassign_scope_member, make_req({ org_id: hub_legacy_uuid(1), scope_id: hub_legacy_uuid(5), user_id: hub_legacy_uuid(3) }), res);
        expect(mock_service.unassign_scope_member).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('unassign_scope_member rejects missing scope_id with 422', async () => {
        const res = mock_res();
        await call(controller.unassign_scope_member, make_req({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(3) }), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }));
    });

    // --- get_scopes ---

    it('get_scopes: own user_id allowed without admin', async () => {
        const res = mock_res();
        const non_admin_auth = { user: { id: hub_legacy_uuid(1), role: 'user' }, org_slugs: [], org_ids: [], scopes: [] };
        await call(controller.get_scopes, make_req({ user_id: hub_legacy_uuid(1) }, non_admin_auth as any), res);
        expect(mock_scopes_service.get_for_user).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get_scopes: other user_id without admin → 403', async () => {
        const res = mock_res();
        const non_admin_auth = { user: { id: hub_legacy_uuid(1), role: 'user' }, org_slugs: [], org_ids: [], scopes: [] };
        await call(controller.get_scopes, make_req({ user_id: hub_legacy_uuid(2) }, non_admin_auth as any), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status_code: 403 }));
    });

    it('get_scopes: no user_id + admin → list catalog', async () => {
        const res = mock_res();
        await call(controller.get_scopes, make_req({}), res);
        expect(mock_scopes_service.list_catalog).toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get_scopes: no user_id + non-admin → 403', async () => {
        const res = mock_res();
        const non_admin_auth = { user: { id: hub_legacy_uuid(1), role: 'user' }, org_slugs: [], org_ids: [], scopes: [] };
        await call(controller.get_scopes, make_req({}, non_admin_auth as any), res);
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ status_code: 403 }));
    });
});
