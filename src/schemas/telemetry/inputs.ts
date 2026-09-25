/**
 * Telemetry API — Zod request schemas (SoT for inbound bodies).
 *
 * Paths: POST /v1/runs/report_telemetry, POST /v1/runs/get_telemetry
 * Envelope: flat (TEL-S0 — no `{ ok, data }` yet).
 *
 * Tenancy: `kind: summary` requires body `org_id` — never invent from X-Org-Id.
 */

import { z } from 'zod';
import { MAX_WINDOW_DAYS } from '../../services/run_telemetry.service.js';

const model_usage_schema = z.object({
    provider: z.string().describe('LLM provider id'),
    model: z.string().describe('Model id'),
    tokens_in: z.number().describe('Input token count'),
    tokens_out: z.number().describe('Output token count'),
    llm_calls: z.number().describe('Number of LLM calls'),
});

const traces_span_schema = z.object({
    span_id: z.string().min(1).describe('OTEL span id'),
    trace_id: z.string().min(1).describe('OTEL trace id'),
    parent_span_id: z.string().nullable().optional().describe('Parent span id, if any'),
    name: z.string().describe('Span display name'),
    kind: z.string().min(1).describe('Span kind'),
    status_code: z.string().min(1).describe('OTEL status code'),
    status_message: z.string().nullable().optional().describe('Optional status message'),
    start_unix_nano: z.string().describe('Start time as unix nanoseconds string'),
    end_unix_nano: z.string().describe('End time as unix nanoseconds string'),
    attributes: z.record(z.unknown()).optional().describe('Span attributes map'),
    events: z.array(z.object({
        name: z.string().describe('Event name'),
        time_unix_nano: z.string().describe('Event time as unix nanoseconds string'),
        attributes: z.record(z.unknown()).optional().describe('Event attributes'),
    }).transform((e) => ({
        name: e.name,
        time_unix_nano: e.time_unix_nano,
        attributes: e.attributes ?? {},
    }))).optional().describe('Span events'),
});

/** Daemon → Hub: token/cost snapshot or OTEL span batch. Discriminator: `kind`. */
export const ReportTelemetryInput = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('usage').describe('Usage snapshot ingest'),
        snapshot_type: z.enum(['phase', 'run']).describe('Phase-level or run-level snapshot'),
        run_id: z.string().min(1).describe('Run id the snapshot belongs to'),
        phase: z.string().optional().describe('Phase name when snapshot_type is phase'),
        total_tokens_in: z.number().describe('Total input tokens'),
        total_tokens_out: z.number().describe('Total output tokens'),
        total_duration_ms: z.number().describe('Total duration in milliseconds'),
        total_llm_calls: z.number().describe('Total LLM calls'),
        total_invocations: z.number().describe('Total tool/agent invocations'),
        by_phase: z.record(z.unknown()).optional().describe('Per-phase breakdown'),
        by_agent: z.record(z.unknown()).optional().describe('Per-agent breakdown'),
        by_model: z.record(model_usage_schema).optional().describe('Per-model breakdown'),
    }),
    z.object({
        kind: z.literal('traces').describe('OTEL span batch ingest'),
        run_id: z.string().min(1).describe('Run id the spans belong to'),
        daemon_id: z.string().nullable().optional().describe('Reporting daemon id'),
        realm_id: z.string().nullable().optional().describe('Realm id when known'),
        spans: z.array(traces_span_schema).min(1).max(512).describe('Span batch (1–512)'),
    }),
]);
export type ReportTelemetryInput = z.infer<typeof ReportTelemetryInput>;

/** SPA → Hub: read usage JSONB, span tree, or fleet rollup. Discriminator: `kind`. */
export const GetTelemetryInput = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('usage').describe('Read run + phase usage snapshots'),
        run_id: z.string().min(1).describe('Run id'),
    }),
    z.object({
        kind: z.literal('spans').describe('Read OTEL span tree for a run'),
        run_id: z.string().min(1).describe('Run id'),
    }),
    z.object({
        kind: z.literal('summary').describe('Fleet telemetry rollup for home dashboard'),
        org_id: z.string().uuid().describe(
            'Organization UUID. Required for fleet summary — never invent from X-Org-Id.',
        ),
        window_days: z.number().int().positive().max(MAX_WINDOW_DAYS).optional()
            .describe(`Lookback window in days (max ${MAX_WINDOW_DAYS})`),
    }),
]);
export type GetTelemetryInput = z.infer<typeof GetTelemetryInput>;
