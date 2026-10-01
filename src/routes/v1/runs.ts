/**
 * Runs routes — run lifecycle, logs, telemetry, status updates, activity reporting, and SSE stream.
 *
 * POST   /v1/runs/get
 * POST   /v1/runs/get_by_id
 * POST   /v1/runs/create
 * POST   /v1/runs/complete
 * POST   /v1/runs/resume
 * POST   /v1/runs/cancel
 * POST   /v1/runs/supply_inputs
 * POST   /v1/runs/enqueue
 * POST   /v1/runs/claim
 * POST   /v1/runs/append_logs
 * POST   /v1/runs/get_logs
 * POST   /v1/runs/report_telemetry
 * POST   /v1/runs/get_telemetry
 * POST   /v1/runs/get_status
 * POST   /v1/runs/update_status
 * POST   /v1/runs/report_activity
 * GET    /v1/runs/stream
 * POST   /v1/runs/create_rdr
 */
import type { Router } from 'express';
import { with_dedup } from '../../middleware/inbound_dedup.js';
import { require_token_scope } from '../../middleware/require_token_scope.js';
import { RunController } from '../../controllers/runs_controller.js';
import { LogsController } from '../../controllers/logs_controller.js';
import { TelemetryController } from '../../controllers/telemetry_controller.js';
import { RunEventStreamController } from '../../controllers/run_event_stream_controller.js';

export function register_runs_routes(router: Router): void {
    const runs = new RunController();
    const telemetry = new TelemetryController();

    router.post('/runs/get', runs.wrap(runs.get));
    router.post('/runs/get_by_id', runs.wrap(runs.get_by_id));
    router.post('/runs/create', with_dedup(runs.wrap(runs.create)));
    router.post('/runs/complete', with_dedup(runs.wrap(runs.complete)));
    router.post('/runs/resume', with_dedup(runs.wrap(runs.resume)));
    router.post('/runs/cancel', runs.wrap(runs.cancel));
    router.post('/runs/supply_inputs', runs.wrap(runs.supply_inputs));
    router.post('/runs/enqueue', require_token_scope('dispatch'), runs.wrap(runs.enqueue));
    router.post('/runs/claim', runs.wrap(runs.claim));

    router.post('/runs/append_logs', with_dedup(LogsController.append_logs));
    router.post('/runs/get_logs', LogsController.get_logs);
    router.post('/runs/report_telemetry', (req, res, next) => {
        // Dedup usage reports only (daemon outbox). Traces batches are larger / non-idempotent the same way.
        const handler = telemetry.wrap(telemetry.report_telemetry);
        if (req.body?.kind === 'usage') {
            return with_dedup(handler)(req, res, next);
        }
        return handler(req, res, next);
    });
    router.post('/runs/get_telemetry', telemetry.wrap(telemetry.get_telemetry));

    router.post('/runs/get_status', runs.wrap(runs.get_status));
    router.post('/runs/update_status', with_dedup(runs.wrap(runs.update_status)));

    router.post('/runs/report_activity', with_dedup(RunEventStreamController.report_activity));
    router.get('/runs/stream', RunEventStreamController.stream);

    router.post('/runs/create_rdr', runs.wrap(runs.create_rdr));
}
