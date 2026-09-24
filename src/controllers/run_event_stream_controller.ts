/**
 * RunEventStreamController — live run activity (timeline) + SSE.
 *
 * POST /v1/runs/report_activity — daemon phase/lifecycle rows for SSE + state.
 * GET  /v1/runs/stream?run_id= — browser SSE (replays then live).
 *
 * Not `report_telemetry` / `get_telemetry` (usage tokens/cost + OTEL spans).
 */

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { RunService } from '../services/run.service.js';
import {
    subscribe_run_events,
    unsubscribe_run_events,
    type RunEventListener,
} from '../services/run_event_bus.js';
import { add_viewer, remove_viewer } from '../services/run_viewer.service.js';
import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('run-event-stream');

/** Heartbeat interval for SSE keepalive (30s). */
const HEARTBEAT_INTERVAL_MS = 30_000;

const report_activity_event_schema = z.object({
    event_type: z.string().min(1),
    phase: z.string().nullable().optional(),
    agent: z.string().nullable().optional(),
    payload_json: z.string().nullable().optional(),
    created_at: z.number(),
});

/** Daemon → Hub live timeline rows (SSE). Not usage/spans — use report_telemetry. */
const report_activity_schema = z.object({
    run_id: z.string().min(1),
    daemon_id: z.string().nullable().optional(),
    realm_id: z.string().nullable().optional(),
    events: z.array(report_activity_event_schema),
    replay: z.boolean().optional(),
});


export class RunEventStreamController {

    /**
     * POST /v1/runs/report_activity
     *
     * Daemon batch of phase/lifecycle activity rows for the run timeline + SSE.
     * Lifecycle types (e.g. phase.input_required) update `runs.state` as a side effect.
     *
     * Not telemetry: tokens/cost/OTEL go to `POST /v1/runs/report_telemetry`.
     */
    static async report_activity(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = report_activity_schema.parse(req.body ?? {});
            const { run_id, daemon_id, realm_id, events, replay } = body;

            const result = await RunService.ingest_events(
                run_id,
                daemon_id ?? null,
                realm_id ?? null,
                events,
            );

            res.json({ ok: true, count: result.count, replay: replay ?? false });
        } catch (err) {
            // FK violation here means the run row doesn't exist on Hub.
            // Return 200 so the daemon outbox marks the entry as delivered
            // and stops retrying — the run will never appear, so these
            // events are permanently orphaned.
            const seq_name = (err as Record<string, unknown>)?.name as string | undefined;
            if (seq_name === 'SequelizeForeignKeyConstraintError') {
                const run_id = req.body?.run_id ?? 'unknown';
                log.warn('event_ingest_orphaned_run', {
                    run_id,
                    event_count: Array.isArray(req.body?.events) ? req.body.events.length : 0,
                });
                res.json({ ok: true, count: 0, dropped: true });
                return;
            }
            next(err);
        }
    }

    /**
     * GET /v1/runs/stream?run_id=
     *
     * SSE endpoint for real-time activity streaming. On connection:
     * 1. Replays existing events (optionally from a cursor via ?after_id=).
     * 2. Subscribes to the in-process event bus for live events.
     * 3. Registers viewer via RunViewerService (triggers daemon streaming).
     * 4. Sends keepalive comments every 30s.
     *
     * On disconnect: unsubscribes and deregisters viewer.
     */
    static async stream(req: Request, res: Response): Promise<void> {
        const run_id_raw = typeof req.query.run_id === 'string'
            ? req.query.run_id
            : (req.params as Record<string, string | undefined>)['run_id'];
        const run_id = Array.isArray(run_id_raw) ? run_id_raw[0] : run_id_raw;
        if (!run_id?.trim()) {
            res.status(400).json({ error: 'missing_run_id' });
            return;
        }

        // Parse optional cursor for reconnect replay (UUID event id).
        const after_id_raw = String(req.query['after_id'] ?? '').trim();
        const after_id = after_id_raw || undefined;

        // SSE headers.
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        // Assign a unique viewer ID for this connection.
        const viewer_id = randomUUID();

        // Track sent event ids for duplicate prevention (UUID PKs).
        const sent_ids = new Set<string>();

        // Replay existing events from the database.
        try {
            const existing = await RunService.get_events(run_id, after_id);
            for (const event of existing) {
                _write_sse(res, event);
                sent_ids.add(String(event.id));
            }
        } catch (err) {
            log.warn(`replay failed for run ${run_id}: ${(err as Error).message}`);
        }

        // Subscribe to live events from the in-process event bus.
        const on_event: RunEventListener = (event) => {
            const eid = String(event.id);
            if (sent_ids.has(eid)) return;
            sent_ids.add(eid);
            _write_sse(res, event);
        };
        subscribe_run_events(run_id, on_event);

        // Register viewer — triggers daemon subscribe on first viewer.
        void add_viewer(run_id, viewer_id);

        // Heartbeat to prevent proxy/LB timeout.
        const heartbeat = setInterval(() => {
            res.write(': keepalive\n\n');
        }, HEARTBEAT_INTERVAL_MS);

        // Cleanup on disconnect.
        const cleanup = () => {
            clearInterval(heartbeat);
            unsubscribe_run_events(run_id, on_event);
            void remove_viewer(run_id, viewer_id);
            log.info(`SSE closed for run=${run_id} viewer=${viewer_id}`);
        };

        req.on('close', cleanup);
        req.on('error', cleanup);

        log.info(`SSE opened for run=${run_id} viewer=${viewer_id}`);
    }
}


/** Write a single event as an SSE data frame. */
function _write_sse(res: Response, event: {
    id: string;
    event_type: string;
    phase: string | null;
    agent: string | null;
    payload: unknown;
    timestamp: number;
}): void {
    const data = {
        id: event.id,
        event_type: event.event_type,
        phase: event.phase,
        agent: event.agent,
        payload: event.payload,
        timestamp: event.timestamp,
    };
    res.write(`id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(data)}\n\n`);
}
