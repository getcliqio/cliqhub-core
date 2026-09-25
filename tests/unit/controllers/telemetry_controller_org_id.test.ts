/**
 * TelemetryController.get_telemetry summary — body org_id (never X-Org-Id invent).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../../../src/services/realm.service.js', () => ({
    RealmService: {
        list_for_user: vi.fn().mockResolvedValue({ realms: [], total: 0 }),
    },
}));

vi.mock('../../../src/services/run_telemetry.service.js', () => ({
    RunTelemetryService: {
        summary: vi.fn().mockResolvedValue({ totals: { runs: 0 } }),
    },
    MAX_WINDOW_DAYS: 90,
}));

vi.mock('../../../src/models/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/models/index.js')>();
    return { ...actual, Realm: { findByPk: vi.fn() } };
});

import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { ApiError } from '../../../src/lib/api_error.js';
import type { AuthContext } from '../../../src/types/vo.js';
import { TelemetryController } from '../../../src/controllers/telemetry_controller.js';
import { RealmService } from '../../../src/services/realm.service.js';
import { RunTelemetryService } from '../../../src/services/run_telemetry.service.js';

const ORG_A = hub_legacy_uuid(10);
const ORG_B = hub_legacy_uuid(20);
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
                current_org_id: ORG_B,
            }
            : undefined,
    } as unknown as Request;
}

describe('TelemetryController.get_telemetry summary org_id', () => {
    const telemetry = new TelemetryController();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(RealmService.list_for_user).mockResolvedValue({ realms: [], total: 0 } as never);
        vi.mocked(RunTelemetryService.summary).mockResolvedValue({ totals: { runs: 0 } } as never);
    });

    it('summary without org_id → 422; no invent from current_org_id', async () => {
        // BaseController.parse_body throws errors/ApiError (`status`, not status_code).
        await expect(
            telemetry.get_telemetry(
                make_req({ kind: 'summary' }, pat_auth([ORG_A])) as never,
                mock_res() as never,
            ),
        ).rejects.toMatchObject({ status: 422, code: 'invalid_params' });
        expect(RunTelemetryService.summary).not.toHaveBeenCalled();
    });

    it('summary with org_id → list_for_user(org_id) + summary', async () => {
        const res = mock_res();
        await telemetry.get_telemetry(
            make_req({ kind: 'summary', org_id: ORG_A, window_days: 7 }, pat_auth([ORG_A])) as never,
            res as never,
        );
        expect(RealmService.list_for_user).toHaveBeenCalledWith(String(USER_A), { org_id: ORG_A });
        expect(RunTelemetryService.summary).toHaveBeenCalled();
    });

    it('summary foreign org_id → 403', async () => {
        await expect(
            telemetry.get_telemetry(
                make_req({ kind: 'summary', org_id: ORG_B }, pat_auth([ORG_A])) as never,
                mock_res() as never,
            ),
        ).rejects.toMatchObject({ status_code: 403 });
        expect(ApiError).toBeTruthy();
    });
});
