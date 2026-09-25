import type { Router, RequestHandler } from 'express';
import { with_dedup } from '../../middleware/inbound_dedup.js';
import { require_token_scope } from '../../middleware/require_token_scope.js';
import { RunController } from '../../controllers/runs_controller.js';
import { LogsController } from '../../controllers/logs_controller.js';
import { TelemetryController } from '../../controllers/telemetry_controller.js';
import { RunEventStreamController } from '../../controllers/run_event_stream_controller.js';

export function register_runs_routes(router: Router, auth: RequestHandler): void {
    const runs = new RunController();
    const telemetry = new TelemetryController();

    router.post('/runs/get', auth, runs.wrap(runs.get));
    router.post('/runs/get_by_id', auth, runs.wrap(runs.get_by_id));
    router.post('/runs/create', auth, with_dedup(runs.wrap(runs.create)));
    router.post('/runs/complete', auth, with_dedup(runs.wrap(runs.complete)));
    router.post('/runs/resume', auth, with_dedup(runs.wrap(runs.resume)));
    router.post('/runs/cancel', auth, runs.wrap(runs.cancel));
    router.post('/runs/supply_inputs', auth, runs.wrap(runs.supply_inputs));
    router.post('/runs/enqueue', auth, require_token_scope('dispatch'), runs.wrap(runs.enqueue));
    router.post('/runs/claim', auth, runs.wrap(runs.claim));

    router.post('/runs/append_logs', auth, with_dedup(LogsController.append_logs));
    router.post('/runs/get_logs', auth, LogsController.get_logs);
    router.post('/runs/report_telemetry', auth, (req, res, next) => {
        // Dedup usage reports only (daemon outbox). Traces batches are larger / non-idempotent the same way.
        const handler = telemetry.wrap(telemetry.report_telemetry);
        if (req.body?.kind === 'usage') {
            return with_dedup(handler)(req, res, next);
        }
        return handler(req, res, next);
    });
    router.post('/runs/get_telemetry', auth, telemetry.wrap(telemetry.get_telemetry));

    router.post('/runs/get_status', auth, runs.wrap(runs.get_status));
    router.post('/runs/update_status', auth, with_dedup(runs.wrap(runs.update_status)));

    router.post('/runs/report_activity', auth, with_dedup(RunEventStreamController.report_activity));
    router.get('/runs/stream', auth, RunEventStreamController.stream);

    router.post('/runs/artifacts/create', auth, runs.wrap(runs.artifacts_create));
}
