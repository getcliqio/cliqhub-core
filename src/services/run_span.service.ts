/**
 * OTEL span ingestion + query for run observability (Phase 1).
 *
 * Daemons POST batched spans to /v1/runs/report_telemetry (`kind: traces`). We insert
 * with `ON CONFLICT (span_id) DO NOTHING` so duplicate flushes are
 * safe. Each newly inserted span is published to the in-process
 * `RUN_SPAN_BUS` so the SSE endpoint can push it to any watching
 * Timeline tab in real time.
 */

import { EventEmitter } from 'node:events';

import { QueryTypes } from 'sequelize';

import { get_sequelize } from '../lib/sequelize.js';
import { RunSpan } from '../models/run_span.model.js';

export interface SpanEvent {
    name: string;
    time_unix_nano: string;
    attributes: Record<string, unknown>;
}

export interface SpanIngestRow {
    span_id: string;
    trace_id: string;
    parent_span_id: string | null;
    name: string;
    kind: string;
    status_code: string;
    status_message?: string | null;
    start_unix_nano: string;
    end_unix_nano: string;
    attributes?: Record<string, unknown>;
    events?: SpanEvent[];
}

export interface SpanIngestBatch {
    run_id: string;
    daemon_id?: string | null;
    realm_id?: string | null;
    spans: SpanIngestRow[];
}

export interface RunSpanRecord {
    span_id: string;
    trace_id: string;
    parent_span_id: string | null;
    run_id: string;
    name: string;
    kind: string;
    status_code: string;
    status_message: string | null;
    start_unix_nano: string;
    end_unix_nano: string;
    duration_ms: number;
    attributes: Record<string, unknown>;
    events: SpanEvent[];
    daemon_id: string | null;
    realm_id: string | null;
    created_at: number;
}

/** In-process pub/sub: one bus for all runs; subscribers filter by run_id. */
export const RUN_SPAN_BUS = new EventEmitter();
RUN_SPAN_BUS.setMaxListeners(1024);

/** Event name for a newly persisted span. Payload: {@link RunSpanRecord}. */
export const RUN_SPAN_EVENT = 'span';

export class RunSpanService {
    /**
     * Ingest a batch of spans for a single run. Idempotent by `span_id`
     * (repeated flushes from BatchSpanProcessor are safe). Returns the
     * count of *newly inserted* rows so the client can log.
     */
    static async ingest(batch: SpanIngestBatch): Promise<number> {
        if (!batch.spans.length) return 0;

        const created_at = Date.now();
        const sq = get_sequelize();

        const values: unknown[] = [];
        const rows: string[] = [];
        for (const span of batch.spans) {
            const idx = values.length;
            rows.push(
                `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, `
                + `$${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, $${idx + 10}, `
                + `$${idx + 11}::jsonb, $${idx + 12}::jsonb, $${idx + 13}, $${idx + 14}, $${idx + 15})`,
            );
            values.push(
                span.span_id,
                span.trace_id,
                span.parent_span_id ?? null,
                batch.run_id,
                span.name,
                span.kind,
                span.status_code,
                span.status_message ?? null,
                span.start_unix_nano,
                span.end_unix_nano,
                JSON.stringify(span.attributes ?? {}),
                JSON.stringify(span.events ?? []),
                batch.daemon_id ?? null,
                batch.realm_id ?? null,
                created_at,
            );
        }

        const sql = `
            INSERT INTO cliq."run_spans"
                ("span_id","trace_id","parent_span_id","run_id","name",
                 "kind","status_code","status_message","start_unix_nano","end_unix_nano",
                 "attributes","events","daemon_id","realm_id","created_at")
            VALUES ${rows.join(', ')}
            ON CONFLICT ("span_id") DO NOTHING
            RETURNING "span_id"
        `;
        const inserted = await sq.query<{ span_id: string }>(sql, {
            bind: values,
            type: QueryTypes.SELECT,
        });

        if (inserted.length === 0) return 0;

        // Fan out only the freshly inserted spans (dedup after retries).
        const inserted_ids = new Set(inserted.map((r) => r.span_id));
        for (const span of batch.spans) {
            if (!inserted_ids.has(span.span_id)) continue;
            const record: RunSpanRecord = {
                span_id: span.span_id,
                trace_id: span.trace_id,
                parent_span_id: span.parent_span_id ?? null,
                run_id: batch.run_id,
                name: span.name,
                kind: span.kind,
                status_code: span.status_code,
                status_message: span.status_message ?? null,
                start_unix_nano: span.start_unix_nano,
                end_unix_nano: span.end_unix_nano,
                duration_ms: _duration_ms(span.start_unix_nano, span.end_unix_nano),
                attributes: span.attributes ?? {},
                events: span.events ?? [],
                daemon_id: batch.daemon_id ?? null,
                realm_id: batch.realm_id ?? null,
                created_at,
            };
            RUN_SPAN_BUS.emit(RUN_SPAN_EVENT, record);
        }

        return inserted.length;
    }

    /** List spans for a run, ordered by start time (oldest first). */
    static async list(run_id: string): Promise<RunSpanRecord[]> {
        const rows = await RunSpan.findAll({
            where: { run_id },
            order: [['start_unix_nano', 'ASC']],
        });
        return rows.map(_to_record);
    }

    /** Delete all spans for a run (used by run purge / delete cascade). */
    static async delete_by_run(run_id: string): Promise<number> {
        return RunSpan.destroy({ where: { run_id } });
    }
}

function _duration_ms(start_nano: string, end_nano: string): number {
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

function _to_record(row: InstanceType<typeof RunSpan>): RunSpanRecord {
    const attrs = _coerce_json_object(row.get('attributes'));
    const events = _coerce_json_array(row.get('events'));
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
        duration_ms: _duration_ms(start, end),
        attributes: attrs,
        events: events as unknown as SpanEvent[],
        daemon_id: (row.get('daemon_id') as string | null) ?? null,
        realm_id: (row.get('realm_id') as string | null) ?? null,
        created_at: Number(row.get('created_at')),
    };
}

function _coerce_json_object(raw: unknown): Record<string, unknown> {
    if (!raw) return {};
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch { /* fall through */ }
    }
    return {};
}

function _coerce_json_array(raw: unknown): Array<Record<string, unknown>> {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
        } catch { /* fall through */ }
    }
    return [];
}
