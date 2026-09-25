/**
 * AG-1a — AgentsController org_id tenancy (body + Bearer), not X-Org-Id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { AgentsController } from '../../../src/controllers/agents_controller.js';
import { ApiError } from '../../../src/lib/api_error.js';
import type { AuthContext } from '../../../src/types/vo.js';

const ORG_A = hub_legacy_uuid(10);
const ORG_B = hub_legacy_uuid(20);
const REALM_A = hub_legacy_uuid(30);

vi.mock('../../../src/models/index.js', () => ({
    Realm: {
        findByPk: vi.fn(),
    },
}));

import { Realm } from '../../../src/models/index.js';

const mock_service = {
    list: vi.fn().mockResolvedValue([]),
    get_by_name: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1), name: 'exec' }),
    get_by_catalog_id: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1), name: 'exec' }),
    register: vi.fn().mockResolvedValue({ entry: { id: hub_legacy_uuid(1), name: 'x' }, updated: false }),
    deregister: vi.fn().mockResolvedValue(true),
    list_settings_summary: vi.fn().mockResolvedValue([]),
    get_settings: vi.fn().mockResolvedValue({ name: 'exec', settings: { required: [], optional: [] }, values: {} }),
    update_settings: vi.fn().mockResolvedValue(true),
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

function daemon_auth(realm_id: string): AuthContext {
    return {
        user: { id: hub_legacy_uuid(2), username: 'daemon', role: 'user' } as AuthContext['user'],
        org_slugs: [],
        org_ids: [],
        scopes: [],
        auth_via: 'daemon_token',
        realm_id,
    };
}

function make_req(body: Record<string, unknown>, auth?: AuthContext) {
    return { body, auth } as unknown as Request;
}

describe('AgentsController AG-1a org_id tenancy', () => {
    let controller: AgentsController;

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new AgentsController(mock_service as never);
    });

    it('get succeeds when body org_id is in PAT memberships', async () => {
        const res = mock_res();
        await controller.get(make_req({ org_id: ORG_A }, pat_auth([ORG_A])) as never, res as never);
        expect(mock_service.list).toHaveBeenCalledWith(ORG_A, expect.any(Object), true);
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get rejects missing org_id with 422', async () => {
        const res = mock_res();
        await expect(controller.get(make_req({}, pat_auth([ORG_A])) as never, res as never))
            .rejects.toMatchObject({ status: 422 });
        expect(mock_service.list).not.toHaveBeenCalled();
    });

    it('get rejects when only X-Org-Id would have applied — body org required', async () => {
        const res = mock_res();
        // Auth has memberships but body omits org_id (legacy header path removed).
        await expect(controller.get(make_req({ include_manifest: false }, pat_auth([ORG_A])) as never, res as never))
            .rejects.toMatchObject({ status: 422 });
    });

    it('get forbids org_id outside PAT memberships', async () => {
        const res = mock_res();
        await expect(controller.get(make_req({ org_id: ORG_B }, pat_auth([ORG_A])) as never, res as never))
            .rejects.toBeInstanceOf(ApiError);
        try {
            await controller.get(make_req({ org_id: ORG_B }, pat_auth([ORG_A])) as never, res as never);
        } catch (err) {
            expect(err).toMatchObject({ status_code: 403 });
        }
        expect(mock_service.list).not.toHaveBeenCalled();
    });

    it('get allows daemon token when realm.org_id matches body org_id', async () => {
        vi.mocked(Realm.findByPk).mockResolvedValue({ org_id: ORG_A } as never);
        const res = mock_res();
        await controller.get(make_req({ org_id: ORG_A }, daemon_auth(REALM_A)) as never, res as never);
        expect(Realm.findByPk).toHaveBeenCalledWith(REALM_A);
        expect(mock_service.list).toHaveBeenCalledWith(ORG_A, expect.any(Object), true);
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('get forbids daemon token when realm.org_id mismatches', async () => {
        vi.mocked(Realm.findByPk).mockResolvedValue({ org_id: ORG_A } as never);
        const res = mock_res();
        await expect(controller.get(make_req({ org_id: ORG_B }, daemon_auth(REALM_A)) as never, res as never))
            .rejects.toMatchObject({ status_code: 403 });
        expect(mock_service.list).not.toHaveBeenCalled();
    });

    it('get_settings forbids realm_id belonging to another org', async () => {
        vi.mocked(Realm.findByPk).mockResolvedValue({ org_id: ORG_B } as never);
        const res = mock_res();
        await expect(
            controller.get_settings(
                make_req({ org_id: ORG_A, realm_id: REALM_A }, pat_auth([ORG_A])) as never,
                res as never,
            ),
        ).rejects.toMatchObject({ status_code: 403 });
        expect(mock_service.list_settings_summary).not.toHaveBeenCalled();
    });

    it('register passes body.org_id to service when authorized', async () => {
        const res = mock_res();
        await controller.register(
            make_req({
                org_id: ORG_A,
                name: 'my-agent',
                manifest: { name: 'my-agent', entry: './a.js' },
            }, pat_auth([ORG_A])) as never,
            res as never,
        );
        expect(mock_service.register).toHaveBeenCalledWith(
            ORG_A,
            expect.objectContaining({ name: 'my-agent' }),
        );
        expect(res.status).toHaveBeenCalledWith(201);
    });

    it('get_details / deregister / update_settings authorize then delegate', async () => {
        const res = mock_res();
        const auth = pat_auth([ORG_A]);
        const catalog_id = hub_legacy_uuid(99);

        await controller.get_details(make_req({ org_id: ORG_A, name: 'exec' }, auth) as never, res as never);
        expect(mock_service.get_by_name).toHaveBeenCalledWith(ORG_A, 'exec', undefined, true);

        await controller.get_details(make_req({ org_id: ORG_A, id: catalog_id }, auth) as never, res as never);
        expect(mock_service.get_by_catalog_id).toHaveBeenCalledWith(ORG_A, catalog_id, true);

        await controller.deregister(make_req({ org_id: ORG_A, name: 'exec' }, auth) as never, res as never);
        expect(mock_service.deregister).toHaveBeenCalledWith(ORG_A, {
            id: undefined,
            name: 'exec',
            version: undefined,
        });

        await controller.update_settings(
            make_req({ org_id: ORG_A, id: catalog_id, settings: { values: { k: 'v' } } }, auth) as never,
            res as never,
        );
        expect(mock_service.update_settings).toHaveBeenCalledWith(
            ORG_A,
            catalog_id,
            { values: { k: 'v' } },
            undefined,
        );
    });

    it('get_settings with id loads detail when authorized', async () => {
        const res = mock_res();
        const catalog_id = hub_legacy_uuid(99);
        await controller.get_settings(
            make_req({ org_id: ORG_A, id: catalog_id }, pat_auth([ORG_A])) as never,
            res as never,
        );
        expect(mock_service.get_settings).toHaveBeenCalledWith(ORG_A, catalog_id, undefined);
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('rejects missing auth context', async () => {
        const res = mock_res();
        await expect(controller.get(make_req({ org_id: ORG_A }) as never, res as never))
            .rejects.toMatchObject({ status_code: 401 });
    });

    it('rejects daemon token without realm_id', async () => {
        const res = mock_res();
        const auth = daemon_auth(REALM_A);
        delete auth.realm_id;
        await expect(controller.get(make_req({ org_id: ORG_A }, auth) as never, res as never))
            .rejects.toMatchObject({ status_code: 403 });
    });
});

describe('Agents*Input Zod AG-1a', () => {
    it('AgentsGetInput requires org_id uuid', async () => {
        const { AgentsGetInput } = await import('../../../src/schemas/agents/inputs.js');
        expect(AgentsGetInput.safeParse({}).success).toBe(false);
        expect(AgentsGetInput.safeParse({ org_id: 'not-a-uuid' }).success).toBe(false);
        expect(AgentsGetInput.safeParse({ org_id: ORG_A }).success).toBe(true);
    });

    it('every agents input schema requires org_id', async () => {
        const schemas = await import('../../../src/schemas/agents/inputs.js');
        const cases: Array<{ schema: { safeParse: (v: unknown) => { success: boolean } }; minimal: Record<string, unknown> }> = [
            { schema: schemas.AgentsGetInput, minimal: { org_id: ORG_A } },
            { schema: schemas.AgentsGetDetailsInput, minimal: { org_id: ORG_A, name: 'exec' } },
            { schema: schemas.AgentsRegisterInput, minimal: { org_id: ORG_A, name: 'x', manifest: { entry: './a.js' } } },
            { schema: schemas.AgentsDeregisterInput, minimal: { org_id: ORG_A, name: 'x' } },
            { schema: schemas.AgentsGetSettingsInput, minimal: { org_id: ORG_A } },
            { schema: schemas.AgentsUpdateSettingsInput, minimal: { org_id: ORG_A, id: ORG_A, settings: {} } },
        ];
        for (const { schema, minimal } of cases) {
            expect(schema.safeParse({}).success).toBe(false);
            expect(schema.safeParse(minimal).success).toBe(true);
        }
    });

    it('AgentsGetDetailsInput enforces id XOR name', async () => {
        const { AgentsGetDetailsInput, AgentsDeregisterInput, AgentsUpdateSettingsInput } = await import('../../../src/schemas/agents/inputs.js');
        const id = hub_legacy_uuid(99);
        expect(AgentsGetDetailsInput.safeParse({ org_id: ORG_A }).success).toBe(false);
        expect(AgentsGetDetailsInput.safeParse({ org_id: ORG_A, id, name: 'exec' }).success).toBe(false);
        expect(AgentsGetDetailsInput.safeParse({ org_id: ORG_A, id, version: '1.0.0' }).success).toBe(false);
        expect(AgentsGetDetailsInput.safeParse({ org_id: ORG_A, id }).success).toBe(true);
        expect(AgentsGetDetailsInput.safeParse({ org_id: ORG_A, name: 'exec', version: '1.0.0' }).success).toBe(true);

        expect(AgentsDeregisterInput.safeParse({ org_id: ORG_A, id }).success).toBe(true);
        expect(AgentsDeregisterInput.safeParse({ org_id: ORG_A, name: 'x' }).success).toBe(true);
        expect(AgentsDeregisterInput.safeParse({ org_id: ORG_A, id, name: 'x' }).success).toBe(false);

        expect(AgentsUpdateSettingsInput.safeParse({ org_id: ORG_A, name: 'x', settings: {} }).success).toBe(false);
        expect(AgentsUpdateSettingsInput.safeParse({ org_id: ORG_A, id, settings: {} }).success).toBe(true);
    });
});
