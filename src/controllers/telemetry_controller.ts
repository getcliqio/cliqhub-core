/**
 * Run telemetry — durable usage snapshots + OTEL spans (not live activity).
 *
 * Do not confuse with `POST /v1/runs/report_activity` (phase/lifecycle rows for
 * SSE). Telemetry is metrics/traces for cost, tokens, and span trees.
 *
 *   POST /v1/runs/report_telemetry — daemon write (`kind: usage | traces`)
 *   POST /v1/runs/get_telemetry    — SPA read (`kind: usage | spans | summary`)
 *
 * Envelope: `{ ok: true, data: T }` via BaseController.ok (TEL-ENV).
 */

import type { Request } from 'express';
import { BaseController } from './base_controller.js';
import { RunService } from '../services/run.service.js';
import { RealmService } from '../services/realm.service.js';
import { RunSpanService } from '../services/run_span.service.js';
import {
    RunTelemetryService,
} from '../services/run_telemetry.service.js';
import { ApiError } from '../lib/api_error.js';
import { Realm } from '../models/index.js';
import type { AuthContext } from '../types/vo.js';
import type { ApiOkResponse, ApiRequest, BooleanData } from '../types/api_response.js';
import {
    GetTelemetryInput,
    ReportTelemetryInput,
} from '../schemas/telemetry/inputs.js';
import type {
    GetTelemetryData,
    ReportTelemetryData,
    TelemetryReportData,
    TelemetrySpanData,
    TelemetrySummaryData,
    TelemetryUsageData,
} from '../schemas/telemetry/data.js';

export class TelemetryController extends BaseController {
    /**
     * Bearer must be allowed to act on `org_id`.
     * PAT/session: org_id ∈ auth.org_ids. Daemon token: realm.org_id === org_id.
     * Site hub admin may act on any org_id.
     */
    private async assert_org_authorized(auth: AuthContext | undefined, org_id: string): Promise<void> {
        // No credential context — refuse rather than invent tenancy.
        if (!auth) {
            throw ApiError.unauthorized('authentication required');
        }

        // Site admin may target any org.
        if (auth.user?.role === 'admin') return;

        // Daemon tokens are realm-bound; tenancy is the realm's org.
        if (auth.auth_via === 'daemon_token') {
            if (!auth.realm_id) {
                throw ApiError.forbidden('daemon token has no realm binding');
            }
            const realm = await Realm.findByPk(auth.realm_id);
            if (!realm || realm.org_id !== org_id) {
                throw ApiError.forbidden('org_id does not match daemon realm organization');
            }
            return;
        }

        // PAT / session: live membership list from auth middleware.
        if (!auth.org_ids.includes(org_id)) {
            throw ApiError.forbidden('not a member of the requested organization');
        }
    }

    private auth_from(req: Request): AuthContext | undefined {
        return req.auth;
    }

    /**
     * POST /v1/runs/report_telemetry — daemon usage snapshot or OTEL spans.
     *
     * Not `report_activity`: that endpoint is live phase/lifecycle rows for SSE.
     * This endpoint stores durable metrics (`kind: usage`) or traces (`kind: traces`).
     *
     * @param req - Body: {@link ReportTelemetryInput}
     * @param res - `{ ok: true, data: BooleanData | TelemetryReportData }`
     */
    async report_telemetry(
        req: ApiRequest<ReportTelemetryInput, ReportTelemetryData>,
        res: ApiOkResponse<ReportTelemetryData>,
    ): Promise<void> {
        // Zod SoT — reject unknown / invalid daemon payloads before services.
        const body = this.parse_body(ReportTelemetryInput, req);

        if (body.kind === 'usage') {
            // Pricing enrich happens in the service; pass the parsed usage arm through.
            const { get_model_pricing_service } = await import('../services/model_pricing.service.js');
            const pricing = get_model_pricing_service();
            const { kind: _kind, ...usage_payload } = body;
            await RunService.ingest_usage_snapshot(usage_payload, pricing);
            // Usage ingest is fire-and-forget ack — BooleanData.
            const ack: BooleanData = true;
            this.ok(res, ack);
            return;
        }

        // kind: traces — pass the parsed traces arm (minus discriminator) to ingest.
        const { kind: _kind, ...traces_payload } = body;
        const inserted = await RunSpanService.ingest(traces_payload);
        // Wire DTO: how many rows were new vs how many arrived in this batch.
        const data: TelemetryReportData = {
            inserted,
            received: traces_payload.spans.length,
        };
        this.ok(res, data);
    }

    /**
     * POST /v1/runs/get_telemetry — SPA usage, spans, or fleet summary.
     *
     * `kind: usage` → run + phase usage JSONB; `spans` → OTEL tree;
     * `summary` → home-dashboard fleet rollup (not live activity).
     *
     * @param req - Body: {@link GetTelemetryInput}
     * @param res - `{ ok: true, data: TelemetryUsageData | TelemetrySpanData[] | TelemetrySummaryData }`
     */
    async get_telemetry(
        req: ApiRequest<GetTelemetryInput, GetTelemetryData>,
        res: ApiOkResponse<GetTelemetryData>,
    ): Promise<void> {
        // Zod SoT — discriminant drives which DTO the service must return.
        const body = this.parse_body(GetTelemetryInput, req);

        if (body.kind === 'usage') {
            // Service returns TelemetryUsageData — no cast at the boundary.
            const data: TelemetryUsageData = await RunService.get_usage(body.run_id);
            this.ok(res, data);
            return;
        }

        if (body.kind === 'spans') {
            // Mapper inside the service projects rows → TelemetrySpanData[].
            const data: TelemetrySpanData[] = await RunSpanService.list(body.run_id);
            this.ok(res, data);
            return;
        }

        // kind: summary — invent SoT is body.org_id (TEL-ORG); never X-Org-Id.
        const user_id = req.user?.user_id;
        if (!user_id) throw ApiError.unauthorized('login required');
        await this.assert_org_authorized(this.auth_from(req), body.org_id);
        // Visible realms for this org only — service does not re-authorize.
        const { realms } = await RealmService.list_for_user(user_id, { org_id: body.org_id });
        const data: TelemetrySummaryData = await RunTelemetryService.summary({
            visible_realm_ids: realms.map((r) => r.id),
            window_days: body.window_days,
        });
        this.ok(res, data);
    }
}
