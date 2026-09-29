/**
 * RunController.get — body org_id tenancy (never X-Org-Id invent).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../../../src/services/run.service.js', () => ({
    RunService: {
        list_recent: vi.fn().mockResolvedValue({ runs: [], total: 0 }),
    },
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

import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { AuthContext } from '../../../src/schemas/auth_types.js';
import { RunController } from '../../../src/controllers/runs_controller.js';
import { RunService } from '../../../src/services/run.service.js';

const ORG_A = hub_legacy_uuid(10);
const ORG_B = hub_legacy_uuid(20);
const REALM_A = hub_legacy_uuid(30);
const USER_A = hub_legacy_uuid(1);

function mock_res() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

function pat_auth(org_ids: string[], role: 'user' | 'admin' = 'user'): AuthContext {
    return {
        user: { id: USER_A, username: 'alice', role } as AuthContext['user'],
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
                role: auth.user.role,
            }
            : undefined,
    } as unknown as Request;
}

describe('RunController.get org_id tenancy', () => {
    const runs = new RunController();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(RunService.list_recent).mockResolvedValue({ runs: [], total: 0 } as never);
    });

    it('org-scoped list without org_id → 422 via parse_body; no invent', async () => {
        // BaseController.parse_body throws errors/ApiError (`status`, not status_code).
        await expect(
            runs.get(make_req({ limit: 10 }, pat_auth([ORG_A])) as never, mock_res() as never),
        ).rejects.toMatchObject({ status: 422, code: 'invalid_params' });
        expect(RunService.list_recent).not.toHaveBeenCalled();
    });

    it('org-scoped list requires body org_id — 422 when omitted', async () => {
        // Body empty — must fail Zod via parse_body.
        await expect(
            runs.get(make_req({}, pat_auth([ORG_A, ORG_B])) as never, mock_res() as never),
        ).rejects.toMatchObject({ status: 422, code: 'invalid_params' });
        expect(RunService.list_recent).not.toHaveBeenCalled();
    });

    it('org-scoped list with membership org_id → list_recent(org_id)', async () => {
        const res = mock_res();
        await runs.get(make_req({ org_id: ORG_A, limit: 10 }, pat_auth([ORG_A])) as never, res as never);
        expect(RunService.list_recent).toHaveBeenCalledWith(
            10,
            undefined,
            expect.objectContaining({ org_id: ORG_A }),
        );
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            ok: true,
            data: expect.objectContaining({
                items: [],
                total: 0,
            }),
        }));
    });

    it('org-scoped list with foreign org_id → 403', async () => {
        await expect(
            runs.get(make_req({ org_id: ORG_B, limit: 10 }, pat_auth([ORG_A])) as never, mock_res() as never),
        ).rejects.toMatchObject({ status_code: 403 });
        expect(RunService.list_recent).not.toHaveBeenCalled();
    });

    it('realm_id path does not require org_id', async () => {
        const res = mock_res();
        await runs.get(make_req({ realm_id: REALM_A, limit: 5 }, pat_auth([ORG_A])) as never, res as never);
        expect(RunService.list_recent).toHaveBeenCalledWith(
            5,
            undefined,
            expect.objectContaining({ realm_id: REALM_A, org_id: undefined }),
        );
    });

    it('daemon_id path does not invent org_id from header', async () => {
        const res = mock_res();
        await runs.get(make_req({ daemon_id: 'daemon-1', limit: 5 }, pat_auth([ORG_A])) as never, res as never);
        expect(RunService.list_recent).toHaveBeenCalledWith(
            5,
            'daemon-1',
            expect.objectContaining({ org_id: undefined }),
        );
    });

    it('parent_run_id path skips org_id requirement and calls list_recent', async () => {
        const PARENT = hub_legacy_uuid(99);
        const res = mock_res();
        await runs.get(make_req({ parent_run_id: PARENT }, pat_auth([ORG_A])) as never, res as never);
        expect(RunService.list_recent).toHaveBeenCalledWith(
            undefined,
            undefined,
            expect.objectContaining({ parent_run_id: PARENT, org_id: undefined }),
        );
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            ok: true,
            data: expect.objectContaining({ items: [], total: 0 }),
        }));
    });

    it('workspace_id path skips org_id requirement and calls list_recent', async () => {
        const WS = hub_legacy_uuid(50);
        const res = mock_res();
        await runs.get(make_req({ workspace_id: WS, limit: 20 }, pat_auth([ORG_A])) as never, res as never);
        expect(RunService.list_recent).toHaveBeenCalledWith(
            20,
            undefined,
            expect.objectContaining({ workspace_id: WS, org_id: undefined }),
        );
    });

    it('active_only with workspace_id passes active_only flag to list_recent', async () => {
        const WS = hub_legacy_uuid(51);
        const res = mock_res();
        await runs.get(make_req({ workspace_id: WS, active_only: true }, pat_auth([ORG_A])) as never, res as never);
        expect(RunService.list_recent).toHaveBeenCalledWith(
            undefined,
            undefined,
            expect.objectContaining({ workspace_id: WS, active_only: true }),
        );
    });
});
