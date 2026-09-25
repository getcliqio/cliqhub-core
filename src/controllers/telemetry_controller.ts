/**
 * Run telemetry — durable usage snapshots + OTEL spans (not live activity).
 *
 * Do not confuse with `POST /v1/runs/report_activity` (phase/lifecycle rows for
 * SSE). Telemetry is metrics/traces for cost, tokens, and span trees.
 *
 *   POST /v1/runs/report_telemetry — daemon write (`kind: usage | traces`)
 *   POST /v1/runs/get_telemetry    — SPA read (`kind: usage | spans | summary`)
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { RunService } from '../services/run.service.js';
import { RealmService } from '../services/realm.service.js';
import { RunSpanService } from '../services/run_span.service.js';
import {
    RunTelemetryService,
    MAX_WINDOW_DAYS,
} from '../services/run_telemetry.service.js';
import { ApiError } from '../lib/api_error.js';
import { Realm } from '../models/index.js';
import type { AuthContext } from '../types/vo.js';

const model_usage_schema = z.object({
    provider: z.string(),
    model: z.string(),
    tokens_in: z.number(),
    tokens_out: z.number(),
    llm_calls: z.number(),
});

const traces_span_schema = z.object({
    span_id: z.string().min(1),
    trace_id: z.string().min(1),
    parent_span_id: z.string().nullable().optional(),
    name: z.string(),
    kind: z.string().min(1),
    status_code: z.string().min(1),
    status_message: z.string().nullable().optional(),
    start_unix_nano: z.string(),
    end_unix_nano: z.string(),
    attributes: z.record(z.unknown()).optional(),
    events: z.array(z.object({
        name: z.string(),
        time_unix_nano: z.string(),
        attributes: z.record(z.unknown()).optional(),
    }).transform((e) => ({
        name: e.name,
        time_unix_nano: e.time_unix_nano,
        attributes: e.attributes ?? {},
    }))).optional(),
});

/** Daemon → Hub: token/cost snapshot or OTEL span batch. Discriminator: `kind`. */
const report_telemetry_schema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('usage'),
        snapshot_type: z.enum(['phase', 'run']),
        run_id: z.string().min(1),
        phase: z.string().optional(),
        total_tokens_in: z.number(),
        total_tokens_out: z.number(),
        total_duration_ms: z.number(),
        total_llm_calls: z.number(),
        total_invocations: z.number(),
        by_phase: z.record(z.unknown()).optional(),
        by_agent: z.record(z.unknown()).optional(),
        by_model: z.record(model_usage_schema).optional(),
    }),
    z.object({
        kind: z.literal('traces'),
        run_id: z.string().min(1),
        daemon_id: z.string().nullable().optional(),
        realm_id: z.string().nullable().optional(),
        spans: z.array(traces_span_schema).min(1).max(512),
    }),
]);

/** SPA → Hub: read usage JSONB, span tree, or fleet rollup. Discriminator: `kind`. */
const get_telemetry_schema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('usage'),
        run_id: z.string().min(1),
    }),
    z.object({
        kind: z.literal('spans'),
        run_id: z.string().min(1),
    }),
    z.object({
        kind: z.literal('summary'),
        org_id: z.string().uuid().describe(
            'Organization UUID. Required for fleet summary — never invent from X-Org-Id.',
        ),
        window_days: z.number().int().positive().max(MAX_WINDOW_DAYS).optional(),
    }),
]);

export class TelemetryController {
    /**
     * Bearer must be allowed to act on `org_id`.
     * PAT/session: org_id ∈ auth.org_ids. Daemon token: realm.org_id === org_id.
     * Site hub admin may act on any org_id.
     */
    private static async assert_org_authorized(auth: AuthContext | undefined, org_id: string): Promise<void> {
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

    private static auth_from(req: Request): AuthContext | undefined {
        return (req as Request & { auth?: AuthContext }).auth;
    }

    /**
     * POST /v1/runs/report_telemetry — daemon usage snapshot or OTEL spans.
     *
     * Not `report_activity`: that endpoint is live phase/lifecycle rows for SSE.
     * This endpoint stores durable metrics (`kind: usage`) or traces (`kind: traces`).
     */
    static async report_telemetry(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = report_telemetry_schema.parse(req.body ?? {});

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
        } catch (err) {
            next(err);
        }
    }

    /**
     * POST /v1/runs/get_telemetry — SPA usage, spans, or fleet summary.
     *
     * `kind: usage` → run + phase usage JSONB; `spans` → OTEL tree;
     * `summary` → home-dashboard fleet rollup (not live activity).
     */
    static async get_telemetry(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = get_telemetry_schema.parse(req.body ?? {});

            switch (body.kind) {
                case 'usage': {
                    const result = await RunService.get_usage(body.run_id);
                    res.json(result);
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
                    await TelemetryController.assert_org_authorized(
                        TelemetryController.auth_from(req),
                        body.org_id,
                    );
                    const { realms } = await RealmService.list_for_user(user_id, { org_id: body.org_id });
                    const summary = await RunTelemetryService.summary({
                        visible_realm_ids: realms.map((r) => r.id),
                        window_days: body.window_days,
                    });
                    res.json({ ok: true, ...summary });
                    return;
                }
            }
        } catch (err) {
            next(err);
        }
    }
}
