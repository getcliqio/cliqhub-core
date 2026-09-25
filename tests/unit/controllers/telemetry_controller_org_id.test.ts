/**
 * TelemetryController — TEL-ENV `{ ok, data }` + org_id invent.
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
        summary: vi.fn(),
    },
    MAX_WINDOW_DAYS: 90,
}));

vi.mock('../../../src/services/run.service.js', () => ({
    RunService: {
        get_usage: vi.fn().mockResolvedValue({ run: null, phases: [] }),
        ingest_usage_snapshot: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../../../src/services/run_span.service.js', () => ({
    RunSpanService: {
        list: vi.fn().mockResolvedValue([]),
        ingest: vi.fn().mockResolvedValue(2),
    },
}));

vi.mock('../../../src/services/model_pricing.service.js', () => ({
    get_model_pricing_service: vi.fn().mockReturnValue({}),
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
import { RunService } from '../../../src/services/run.service.js';
import { RunSpanService } from '../../../src/services/run_span.service.js';

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

describe('TelemetryController TEL-ENV envelope', () => {
    const telemetry = new TelemetryController();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(RealmService.list_for_user).mockResolvedValue({ realms: [], total: 0 } as never);
        vi.mocked(RunTelemetryService.summary).mockResolvedValue({
            window: { from_ms: 0, to_ms: 1, days: 7 },
            totals: {
                runs: 0, agent_invocations: 0, failures: 0, duration_ms: 0,
                cost_usd: 0, tokens_in: 0, tokens_out: 0,
            },
            by_day: [],
            by_hour: Array.from({ length: 24 }, (_, h) => ({ hour: h, runs: 0, invocations: 0 })),
            by_team: [],
            by_agent_kind: [],
        });
        vi.mocked(RunService.get_usage).mockResolvedValue({ run: null, phases: [] });
        vi.mocked(RunSpanService.list).mockResolvedValue([]);
        vi.mocked(RunSpanService.ingest).mockResolvedValue(2);
    });

    it('summary without org_id → 422; no invent from current_org_id', async () => {
        await expect(
            telemetry.get_telemetry(
                make_req({ kind: 'summary' }, pat_auth([ORG_A])) as never,
                mock_res() as never,
            ),
        ).rejects.toMatchObject({ status: 422, code: 'invalid_params' });
        expect(RunTelemetryService.summary).not.toHaveBeenCalled();
    });

    it('summary with org_id → data: TelemetrySummaryData', async () => {
        const res = mock_res();
        await telemetry.get_telemetry(
            make_req({ kind: 'summary', org_id: ORG_A, window_days: 7 }, pat_auth([ORG_A])) as never,
            res as never,
        );
        expect(RealmService.list_for_user).toHaveBeenCalledWith(String(USER_A), { org_id: ORG_A });
        expect(res.json).toHaveBeenCalledWith({
            ok: true,
            data: expect.objectContaining({
                totals: expect.objectContaining({ runs: 0 }),
                by_day: [],
                by_team: [],
            }),
        });
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

    it('usage → data: { run, phases }', async () => {
        const res = mock_res();
        await telemetry.get_telemetry(
            make_req({ kind: 'usage', run_id: 'run-1' }, pat_auth([ORG_A])) as never,
            res as never,
        );
        expect(res.json).toHaveBeenCalledWith({ ok: true, data: { run: null, phases: [] } });
    });

    it('spans → data: TelemetrySpanData[]', async () => {
        const res = mock_res();
        await telemetry.get_telemetry(
            make_req({ kind: 'spans', run_id: 'run-1' }, pat_auth([ORG_A])) as never,
            res as never,
        );
        expect(res.json).toHaveBeenCalledWith({ ok: true, data: [] });
    });

    it('report usage → data: true', async () => {
        const res = mock_res();
        await telemetry.report_telemetry(
            make_req({
                kind: 'usage',
                snapshot_type: 'run',
                run_id: 'run-1',
                total_tokens_in: 1,
                total_tokens_out: 2,
                total_duration_ms: 3,
                total_llm_calls: 1,
                total_invocations: 1,
            }, pat_auth([ORG_A])) as never,
            res as never,
        );
        expect(RunService.ingest_usage_snapshot).toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith({ ok: true, data: true });
    });

    it('report traces → data: { inserted, received }', async () => {
        const res = mock_res();
        await telemetry.report_telemetry(
            make_req({
                kind: 'traces',
                run_id: 'run-1',
                spans: [{
                    span_id: 's1',
                    trace_id: 't1',
                    name: 'root',
                    kind: 'INTERNAL',
                    status_code: 'OK',
                    start_unix_nano: '1',
                    end_unix_nano: '2',
                }],
            }, pat_auth([ORG_A])) as never,
            res as never,
        );
        expect(RunSpanService.ingest).toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith({ ok: true, data: { inserted: 2, received: 1 } });
    });
});
