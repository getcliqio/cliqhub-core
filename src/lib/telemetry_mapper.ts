/**
 * Projection helpers for run-span rows → wire TelemetrySpanData.
 *
 * Coercion helpers live here because span data comes from the daemon
 * as raw JSON blobs that are stored as TEXT/JSONB and need defensive parsing.
 */

import type { RunSpan } from '../models/run_span.model.js';
import type { TelemetrySpanData } from '../schemas/telemetry_types.js';

function coerce_json_object(raw: unknown): Record<string, unknown> {
    if (!raw) return {};
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    if (typeof raw !== 'string') return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch { /* fall through */ }
    return {};
}

function coerce_span_events(raw: unknown): TelemetrySpanData['events'] {
    let rows: unknown[] = [];
    if (Array.isArray(raw)) rows = raw;
    if (typeof raw === 'string') {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) rows = parsed;
        } catch { /* fall through */ }
    }
    return rows.map((item) => {
        const e = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        return {
            name: String(e.name ?? ''),
            time_unix_nano: String(e.time_unix_nano ?? ''),
            attributes: coerce_json_object(e.attributes),
        };
    });
}

function span_duration_ms(start_nano: string, end_nano: string): number {
    try {
        const start = BigInt(start_nano);
        const end = BigInt(end_nano);
        const delta_ns = end - start;
        if (delta_ns <= 0n) return 0;
        return Number(delta_ns / 1_000_000n);
    } catch {
        return 0;
    }
}

/** Project a RunSpan row to wire TelemetrySpanData. */
export function to_telemetry_span_data(row: InstanceType<typeof RunSpan>): TelemetrySpanData {
    const start = String(row.get('start_unix_nano'));
    const end = String(row.get('end_unix_nano'));
    return {
        span_id: row.get('span_id') as string,
        trace_id: row.get('trace_id') as string,
        parent_span_id: (row.get('parent_span_id') as string | null) ?? null,
        run_id: row.get('run_id') as string,
        name: row.get('name') as string,
        kind: row.get('kind') as string,
        status_code: row.get('status_code') as string,
        status_message: (row.get('status_message') as string | null) ?? null,
        start_unix_nano: start,
        end_unix_nano: end,
        duration_ms: span_duration_ms(start, end),
        attributes: coerce_json_object(row.get('attributes')),
        events: coerce_span_events(row.get('events')),
        daemon_id: (row.get('daemon_id') as string | null) ?? null,
        realm_id: (row.get('realm_id') as string | null) ?? null,
        created_at: Number(row.get('created_at')),
    };
}
