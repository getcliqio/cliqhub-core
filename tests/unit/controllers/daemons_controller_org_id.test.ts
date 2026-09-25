/**
 * DaemonController.get — body org_id tenancy (never X-Org-Id invent).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../../../src/services/daemon.service.js', () => ({
    DaemonService: {
        list: vi.fn().mockResolvedValue({ daemons: [], total: 0 }),
    },
}));

vi.mock('../../../src/models/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/models/index.js')>();
    return {
        ...actual,
        Realm: { findByPk: vi.fn() },
    };
});

import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { AuthContext } from '../../../src/types/vo.js';
import { DaemonController } from '../../../src/controllers/daemons_controller.js';
import { DaemonService } from '../../../src/services/daemon.service.js';

const ORG_A = hub_legacy_uuid(10);
const ORG_B = hub_legacy_uuid(20);
const REALM_A = hub_legacy_uuid(30);
const USER_A = hub_legacy_uuid(1);

function mock_res() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

function pat_auth(org_ids: string[]): AuthContext {
    return {
        user: { id: USER_A, username: 'alice', role: 'user' } as AuthContext['user'],
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
                current_org_id: ORG_B,
            }
            : undefined,
    } as unknown as Request;
}

describe('DaemonController.get org_id tenancy', () => {
    const daemons = new DaemonController();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(DaemonService.list).mockResolvedValue({ daemons: [], total: 0 } as never);
    });

    it('without org_id → 422; does not invent from current_org_id', async () => {
        await expect(
            daemons.get(make_req({ limit: 1 }, pat_auth([ORG_A])) as never, mock_res() as never),
        ).rejects.toMatchObject({ status: 422, code: 'invalid_params' });
        expect(DaemonService.list).not.toHaveBeenCalled();
    });

    it('with membership org_id → list(org_id)', async () => {
        const res = mock_res();
        await daemons.get(make_req({ org_id: ORG_A, limit: 10 }, pat_auth([ORG_A])) as never, res as never);
        expect(DaemonService.list).toHaveBeenCalledWith(
            String(USER_A),
            expect.objectContaining({ org_id: ORG_A, limit: 10 }),
        );
    });

    it('foreign org_id → 403', async () => {
        await expect(
            daemons.get(make_req({ org_id: ORG_B }, pat_auth([ORG_A])) as never, mock_res() as never),
        ).rejects.toMatchObject({ status_code: 403 });
        expect(DaemonService.list).not.toHaveBeenCalled();
    });

    it('realm_id path does not require org_id', async () => {
        const res = mock_res();
        await daemons.get(make_req({ realm_id: REALM_A }, pat_auth([ORG_A])) as never, res as never);
        expect(DaemonService.list).toHaveBeenCalledWith(
            String(USER_A),
            expect.objectContaining({ realm_id: REALM_A, org_id: undefined }),
        );
    });
});
