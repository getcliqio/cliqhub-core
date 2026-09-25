/**
 * Telemetry API — response Zod schemas (SoT for OpenAPI / Mintlify).
 *
 * Paths: POST /v1/runs/report_telemetry, POST /v1/runs/get_telemetry
 * Envelope: `{ ok: true, data: T }` (TEL-ENV).
 */

import { z } from 'zod';

import type { BooleanData } from '../../types/api_response.js';

/** Traces ingest ack — how many spans were new vs received. */
export const TelemetryReportData = z.object({
    inserted: z.number().int().nonnegative().describe('Newly inserted span rows (ON CONFLICT skipped duplicates)'),
    received: z.number().int().nonnegative().describe('Span count in the request batch'),
});
export type TelemetryReportData = z.infer<typeof TelemetryReportData>;

/** One OTEL span on the wire (get_telemetry kind: spans). */
export const TelemetrySpanData = z.object({
    span_id: z.string().describe('OTEL span id'),
    trace_id: z.string().describe('OTEL trace id'),
    parent_span_id: z.string().nullable().describe('Parent span id, or null for roots'),
    run_id: z.string().describe('Hub run id'),
    name: z.string().describe('Span display name'),
    kind: z.string().describe('Span kind'),
    status_code: z.string().describe('OTEL status code'),
    status_message: z.string().nullable().describe('Optional status message'),
    start_unix_nano: z.string().describe('Start time as unix nanoseconds string'),
    end_unix_nano: z.string().describe('End time as unix nanoseconds string'),
    duration_ms: z.number().describe('Derived duration in milliseconds'),
    attributes: z.record(z.string(), z.unknown()).describe('Span attributes map'),
    events: z.array(z.object({
        name: z.string().describe('Event name'),
        time_unix_nano: z.string().describe('Event time as unix nanoseconds string'),
        attributes: z.record(z.string(), z.unknown()).describe('Event attributes'),
    })).describe('Span events'),
    daemon_id: z.string().nullable().describe('Reporting daemon id'),
    realm_id: z.string().nullable().describe('Realm id when known'),
    created_at: z.number().describe('Insert time (unix ms)'),
});
export type TelemetrySpanData = z.infer<typeof TelemetrySpanData>;

/** get_telemetry kind: usage — run + phase usage snapshots. */
export const TelemetryUsageData = z.object({
    run: z.unknown().nullable().describe('Run-level usage_snapshot JSONB, or null'),
    phases: z.array(z.object({
        phase: z.string().describe('Phase name'),
        usage_snapshot: z.unknown().nullable().describe('Phase usage_snapshot JSONB, or null'),
    })).describe('Per-phase usage rows in sequence order'),
});
export type TelemetryUsageData = z.infer<typeof TelemetryUsageData>;

const telemetry_window_schema = z.object({
    from_ms: z.number().describe('Window start (unix ms, UTC)'),
    to_ms: z.number().describe('Window end (unix ms, UTC)'),
    days: z.number().int().positive().describe('Lookback days used for the rollup'),
});

const telemetry_totals_schema = z.object({
    runs: z.number().describe('Distinct runs in window'),
    agent_invocations: z.number().describe('Agent invocation count'),
    failures: z.number().describe('Failed agent invocations'),
    duration_ms: z.number().describe('Total duration ms'),
    cost_usd: z.number().describe('Total estimated cost USD'),
    tokens_in: z.number().describe('Total input tokens'),
    tokens_out: z.number().describe('Total output tokens'),
});

/** Fleet rollup for home dashboard (get_telemetry kind: summary). */
export const TelemetrySummaryData = z.object({
    window: telemetry_window_schema.describe('Rollup time window'),
    totals: telemetry_totals_schema.describe('Aggregate totals across the window'),
    by_day: z.array(z.object({
        date: z.string().describe('UTC calendar day YYYY-MM-DD'),
        runs: z.number().describe('Runs that day'),
        invocations: z.number().describe('Invocations that day'),
        duration_ms: z.number().describe('Duration ms that day'),
        cost_usd: z.number().describe('Cost USD that day'),
        failures: z.number().describe('Failures that day'),
    })).describe('Per-day series'),
    by_hour: z.array(z.object({
        hour: z.number().int().min(0).max(23).describe('UTC hour 0–23'),
        runs: z.number().describe('Runs in that hour bucket'),
        invocations: z.number().describe('Invocations in that hour bucket'),
    })).describe('Fixed 24-length hour-of-day strip'),
    by_team: z.array(z.object({
        team_label: z.string().describe('Canonical @scope/team label'),
        runs: z.number().describe('Runs for this team'),
        invocations: z.number().describe('Invocations for this team'),
        duration_ms: z.number().describe('Duration ms for this team'),
        cost_usd: z.number().describe('Cost USD for this team'),
        failures: z.number().describe('Failures for this team'),
    })).describe('Top teams by activity'),
    by_agent_kind: z.array(z.object({
        kind: z.string().describe('Agent kind (e.g. llm, shell)'),
        invocations: z.number().describe('Invocations for this kind'),
        duration_ms: z.number().describe('Duration ms for this kind'),
        cost_usd: z.number().describe('Cost USD for this kind'),
        failures: z.number().describe('Failures for this kind'),
    })).describe('Rollup by agent kind'),
});
export type TelemetrySummaryData = z.infer<typeof TelemetrySummaryData>;

/** `get_telemetry` success `data` — one shape per `kind`. */
export type GetTelemetryData =
    | TelemetryUsageData
    | TelemetrySpanData[]
    | TelemetrySummaryData;

/** `report_telemetry` success `data` — usage ack vs traces ingest counts. */
export type ReportTelemetryData = BooleanData | TelemetryReportData;
