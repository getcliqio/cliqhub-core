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
import { to_telemetry_span_data } from '../types/mappers.js';
import type { ReportTelemetryInput } from '../schemas/telemetry/inputs.js';
import type { TelemetrySpanData } from '../schemas/telemetry/data.js';

/** Zod traces arm of ReportTelemetryInput, without the `kind` discriminant. */
export type TracesIngestPayload = Omit<Extract<ReportTelemetryInput, { kind: 'traces' }>, 'kind'>;

export type SpanEvent = {
    name: string;
    time_unix_nano: string;
    attributes: Record<string, unknown>;
};

/** Internal VO for the in-process span bus (not the wire DTO). */
export type RunSpanRecord = TelemetrySpanData;

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
    static async ingest(batch: TracesIngestPayload): Promise<number> {
        // Empty batches are a no-op (Zod requires min 1 on the wire; keep guard for callers).
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
                duration_ms: RunSpanService.duration_ms(span.start_unix_nano, span.end_unix_nano),
                attributes: span.attributes ?? {},
                events: (span.events ?? []).map((e) => ({
                    name: e.name,
                    time_unix_nano: e.time_unix_nano,
                    attributes: e.attributes ?? {},
                })),
                daemon_id: batch.daemon_id ?? null,
                realm_id: batch.realm_id ?? null,
                created_at,
            };
            RUN_SPAN_BUS.emit(RUN_SPAN_EVENT, record);
        }

        return inserted.length;
    }

    /** List spans for a run as wire DTOs, ordered by start time (oldest first). */
    static async list(run_id: string): Promise<TelemetrySpanData[]> {
        const rows = await RunSpan.findAll({
            where: { run_id },
            order: [['start_unix_nano', 'ASC']],
        });
        return rows.map((row) => to_telemetry_span_data(row));
    }

    /** Delete all spans for a run (used by run purge / delete cascade). */
    static async delete_by_run(run_id: string): Promise<number> {
        return RunSpan.destroy({ where: { run_id } });
    }

    private static duration_ms(start_nano: string, end_nano: string): number {
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
}
