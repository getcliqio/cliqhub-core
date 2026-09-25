/**
 * Run telemetry — durable usage snapshots + OTEL spans (not live activity).
 *
 * Do not confuse with `POST /v1/runs/report_activity` (phase/lifecycle rows for
 * SSE). Telemetry is metrics/traces for cost, tokens, and span trees.
 *
 *   POST /v1/runs/report_telemetry — daemon write (`kind: usage | traces`)
 *   POST /v1/runs/get_telemetry    — SPA read (`kind: usage | spans | summary`)
 *
 * Structure: BaseController + schemas/telemetry (TEL-S0). Envelope stays flat.
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
import type { FlatApiOkResponse, FlatApiRequest } from '../types/api_response.js';
import {
    GetTelemetryInput,
    ReportTelemetryInput,
} from '../schemas/telemetry/inputs.js';

/** Flat success fields for report_telemetry (usage = ok only; traces adds counts). */
type ReportTelemetryFields = {
    inserted?: number;
    received?: number;
};

/** Flat success fields for get_telemetry variants. */
type GetTelemetryFields = Record<string, unknown>;

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
     * @param res - Flat `{ ok: true }` or `{ ok: true, inserted, received }`
     */
    async report_telemetry(
        req: FlatApiRequest<ReportTelemetryInput, ReportTelemetryFields>,
        res: FlatApiOkResponse<ReportTelemetryFields>,
    ): Promise<void> {
        const body = this.parse_body(ReportTelemetryInput, req);

        switch (body.kind) {
            case 'usage': {
                const { get_model_pricing_service } = await import('../services/model_pricing.service.js');
                const pricing = get_model_pricing_service();
                const { kind: _kind, ...usage_payload } = body;
                await RunService.ingest_usage_snapshot(
                    usage_payload as unknown as Parameters<typeof RunService.ingest_usage_snapshot>[0],
                    pricing,
                );
                res.json({ ok: true });
                return;
            }
            case 'traces': {
                const spans = body.spans.map((s) => ({
                    span_id: s.span_id,
                    trace_id: s.trace_id,
                    parent_span_id: s.parent_span_id ?? null,
                    name: s.name,
                    kind: s.kind,
                    status_code: s.status_code,
                    status_message: s.status_message ?? null,
                    start_unix_nano: s.start_unix_nano,
                    end_unix_nano: s.end_unix_nano,
                    attributes: s.attributes ?? {},
                    events: s.events ?? [],
                }));
                const inserted = await RunSpanService.ingest({
                    run_id: body.run_id,
                    daemon_id: body.daemon_id ?? null,
                    realm_id: body.realm_id ?? null,
                    spans,
                });
                res.json({ ok: true, inserted, received: spans.length });
                return;
            }
        }
    }

    /**
     * POST /v1/runs/get_telemetry — SPA usage, spans, or fleet summary.
     *
     * `kind: usage` → run + phase usage JSONB; `spans` → OTEL tree;
     * `summary` → home-dashboard fleet rollup (not live activity).
     *
     * @param req - Body: {@link GetTelemetryInput}
     * @param res - Flat fields per kind (usage returns `{ run, phases }` without wrapping ok)
     */
    async get_telemetry(
        req: FlatApiRequest<GetTelemetryInput, GetTelemetryFields>,
        res: FlatApiOkResponse<GetTelemetryFields>,
    ): Promise<void> {
        const body = this.parse_body(GetTelemetryInput, req);

        switch (body.kind) {
            case 'usage': {
                // Wire-compatible: historical shape is `{ run, phases }` without `{ ok: true }`.
                const result = await RunService.get_usage(body.run_id);
                res.json(result as unknown as { ok: true } & GetTelemetryFields);
                return;
            }
            case 'spans': {
                const spans = await RunSpanService.list(body.run_id);
                res.json({ ok: true, spans });
                return;
            }
            case 'summary': {
                const user_id = req.user?.user_id;
                if (!user_id) throw ApiError.unauthorized('login required');
                // Body org_id is invent SoT (TEL-ORG) — never X-Org-Id.
                await this.assert_org_authorized(this.auth_from(req), body.org_id);
                const { realms } = await RealmService.list_for_user(user_id, { org_id: body.org_id });
                const summary = await RunTelemetryService.summary({
                    visible_realm_ids: realms.map((r) => r.id),
                    window_days: body.window_days,
                });
                res.json({ ok: true, ...summary });
                return;
            }
        }
    }
}
