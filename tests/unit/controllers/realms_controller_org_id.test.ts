/**
 * RealmsController — body org_id tenancy (never X-Org-Id invent).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { ApiError } from '../../../src/lib/api_error.js';
import type { AuthContext } from '../../../src/types/vo.js';
import {
    RealmCreateInput,
    RealmGetByIdInput,
} from '../../../src/schemas/realms/inputs.js';

const ORG_A = hub_legacy_uuid(10);
const ORG_B = hub_legacy_uuid(20);
const REALM_A = hub_legacy_uuid(30);

vi.mock('../../../src/services/realm.service.js', () => ({
    RealmService: {},
}));
vi.mock('../../../src/services/realm_team_list.service.js', () => ({
    RealmTeamListService: {},
}));
vi.mock('../../../src/services/dispatch.service.js', () => ({
    DispatchService: {},
}));

vi.mock('../../../src/models/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/models/index.js')>();
    return {
        ...actual,
        Realm: {
            findByPk: vi.fn(),
        },
    };
});

vi.mock('../../../src/db/models/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/db/models/index.js')>();
    return {
        ...actual,
        Org: {
            findOne: vi.fn(),
        },
    };
});

import { RealmController } from '../../../src/controllers/realms_controller.js';
import { Realm } from '../../../src/models/index.js';
import { Org } from '../../../src/db/models/index.js';

const mock_realm = {
    create: vi.fn().mockResolvedValue({ id: REALM_A, slug: 'prod', org_id: ORG_A }),
    list_for_user: vi.fn().mockResolvedValue({ realms: [], total: 0 }),
    get: vi.fn().mockResolvedValue({ id: REALM_A, slug: 'prod' }),
    get_by_slug: vi.fn().mockResolvedValue({ id: REALM_A, slug: 'prod' }),
    update: vi.fn().mockResolvedValue({ id: REALM_A, name: 'Prod' }),
    remove: vi.fn().mockResolvedValue(undefined),
    list_members: vi.fn().mockResolvedValue([]),
    resolve_user_member_id: vi.fn().mockResolvedValue(hub_legacy_uuid(1)),
    add_member: vi.fn().mockResolvedValue({ member_id: hub_legacy_uuid(1) }),
    remove_member: vi.fn().mockResolvedValue(undefined),
};

const mock_team_list = {
    add: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue([]),
    sync_team: vi.fn().mockResolvedValue({ queued: 0 }),
};

const mock_dispatch = {
    uninstall_team: vi.fn().mockResolvedValue({ queued: 0 }),
};

function mock_res() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

function pat_auth(org_ids: string[]): AuthContext {
    return {
        user: { id: hub_legacy_uuid(1), username: 'alice', role: 'user' } as AuthContext['user'],
        org_slugs: ['alice'],
        org_ids,
        scopes: [],
        auth_via: 'pat',
    };
}

function make_req(body: Record<string, unknown>, auth?: AuthContext) {
    return {
        body,
        auth,
        user: auth?.user
            ? {
                user_id: String(auth.user.id),
                email: 'alice@test.com',
                org_ids: auth.org_ids,
            }
            : undefined,
    } as unknown as Request;
}

describe('RealmCreateInput / RealmGetByIdInput Zod', () => {
    it('create requires org_id', () => {
        const r = RealmCreateInput.safeParse({ slug: 'prod', name: 'Prod' });
        expect(r.success).toBe(false);
    });

    it('create accepts org_id + slug + name', () => {
        const r = RealmCreateInput.safeParse({ org_id: ORG_A, slug: 'prod', name: 'Prod' });
        expect(r.success).toBe(true);
    });

    it('get_by_id rejects bare slug', () => {
        const r = RealmGetByIdInput.safeParse({ slug: 'prod' });
        expect(r.success).toBe(false);
    });

    it('get_by_id accepts slug + org_id', () => {
        const r = RealmGetByIdInput.safeParse({ slug: 'prod', org_id: ORG_A });
        expect(r.success).toBe(true);
    });

    it('get_by_id accepts slug + org_slug', () => {
        const r = RealmGetByIdInput.safeParse({ slug: 'prod', org_slug: 'acme' });
        expect(r.success).toBe(true);
    });

    it('get_by_id rejects org_id and org_slug together', () => {
        const r = RealmGetByIdInput.safeParse({ slug: 'prod', org_id: ORG_A, org_slug: 'acme' });
        expect(r.success).toBe(false);
    });
});

describe('RealmController org_id tenancy', () => {
    let controller: RealmController;

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new RealmController(
            mock_realm as never,
            mock_team_list as never,
            mock_dispatch as never,
        );
    });

    it('create succeeds when body org_id is in PAT memberships', async () => {
        const res = mock_res();
        await controller.create(
            make_req({ org_id: ORG_A, slug: 'prod', name: 'Prod' }, pat_auth([ORG_A])),
            res,
        );
        expect(mock_realm.create).toHaveBeenCalledWith(
            String(hub_legacy_uuid(1)),
            'prod',
            'Prod',
            { org_id: ORG_A },
        );
        expect(res.json).toHaveBeenCalledWith({ ok: true, realm: expect.any(Object) });
    });

    it('create rejects missing org_id with 422', async () => {
        const res = mock_res();
        await expect(
            controller.create(make_req({ slug: 'prod', name: 'Prod' }, pat_auth([ORG_A])), res),
        ).rejects.toMatchObject({ status: 422 });
        expect(mock_realm.create).not.toHaveBeenCalled();
    });

    it('create rejects org_id not in memberships with 403', async () => {
        const res = mock_res();
        await expect(
            controller.create(
                make_req({ org_id: ORG_B, slug: 'prod', name: 'Prod' }, pat_auth([ORG_A])),
                res,
            ),
        ).rejects.toBeInstanceOf(ApiError);
        expect(mock_realm.create).not.toHaveBeenCalled();
    });

    it('create ignores current_org_id / does not invent from header', async () => {
        const res = mock_res();
        const req = make_req({ org_id: ORG_A, slug: 'prod', name: 'Prod' }, pat_auth([ORG_A]));
        (req.user as { current_org_id?: string }).current_org_id = ORG_B;
        await controller.create(req, res);
        expect(mock_realm.create).toHaveBeenCalledWith(
            expect.any(String),
            'prod',
            'Prod',
            { org_id: ORG_A },
        );
    });

    it('get_by_id realm_id path does not require body org_id', async () => {
        const res = mock_res();
        await controller.get_by_id(
            make_req({ realm_id: REALM_A }, pat_auth([ORG_A])),
            res,
        );
        expect(mock_realm.get).toHaveBeenCalledWith(REALM_A, String(hub_legacy_uuid(1)));
        expect(res.json).toHaveBeenCalledWith({ ok: true, realm: expect.any(Object) });
    });

    it('get_by_id slug + org_id authorizes then loads', async () => {
        const res = mock_res();
        await controller.get_by_id(
            make_req({ slug: 'prod', org_id: ORG_A }, pat_auth([ORG_A])),
            res,
        );
        expect(mock_realm.get_by_slug).toHaveBeenCalledWith('prod', String(hub_legacy_uuid(1)), {
            org_id: ORG_A,
        });
    });

    it('get_by_id slug + org_slug resolves org then loads', async () => {
        vi.mocked(Org.findOne).mockResolvedValue({ id: ORG_A, slug: 'acme' } as never);
        const res = mock_res();
        await controller.get_by_id(
            make_req({ slug: 'prod', org_slug: 'acme' }, pat_auth([ORG_A])),
            res,
        );
        expect(Org.findOne).toHaveBeenCalledWith({ where: { slug: 'acme' } });
        expect(mock_realm.get_by_slug).toHaveBeenCalledWith('prod', String(hub_legacy_uuid(1)), {
            org_id: ORG_A,
        });
    });

    it('update does not call Realm.findByPk for header org gate', async () => {
        const res = mock_res();
        await controller.update(
            make_req({ realm_id: REALM_A, name: 'N' }, pat_auth([ORG_A])),
            res,
        );
        expect(Realm.findByPk).not.toHaveBeenCalled();
        expect(mock_realm.update).toHaveBeenCalled();
    });

    it('delete does not call Realm.findByPk for header org gate', async () => {
        const res = mock_res();
        await controller.delete(
            make_req({ realm_id: REALM_A }, pat_auth([ORG_A])),
            res,
        );
        expect(Realm.findByPk).not.toHaveBeenCalled();
        expect(mock_realm.remove).toHaveBeenCalled();
    });
});
