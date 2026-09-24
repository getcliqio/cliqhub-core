import type { Router, RequestHandler } from 'express';
import { with_dedup } from '../../middleware/inbound_dedup.js';
import { require_token_scope } from '../../middleware/require_token_scope.js';
import { RunController } from '../../controllers/runs_controller.js';
import { LogsController } from '../../controllers/logs_controller.js';
import { TelemetryController } from '../../controllers/telemetry_controller.js';
import { RunEventStreamController } from '../../controllers/run_event_stream_controller.js';

export function register_runs_routes(router: Router, auth: RequestHandler): void {
    router.post('/runs/get', auth, RunController.get);
    router.post('/runs/get_by_id', auth, RunController.get_by_id);
    router.post('/runs/create', auth, with_dedup(RunController.create));
    router.post('/runs/complete', auth, with_dedup(RunController.complete));
    router.post('/runs/resume', auth, with_dedup(RunController.resume));
    router.post('/runs/cancel', auth, RunController.cancel);
    router.post('/runs/supply_inputs', auth, RunController.supply_inputs);
    router.post('/runs/enqueue', auth, require_token_scope('dispatch'), RunController.enqueue);
    router.post('/runs/claim', auth, RunController.claim);

    router.post('/runs/append_logs', auth, with_dedup(LogsController.append_logs));
    router.post('/runs/get_logs', auth, LogsController.get_logs);
    router.post('/runs/report_telemetry', auth, (req, res, next) => {
        // Dedup usage reports only (daemon outbox). Traces batches are larger / non-idempotent the same way.
        if (req.body?.kind === 'usage') {
            return with_dedup(TelemetryController.report_telemetry)(req, res, next);
        }
        return TelemetryController.report_telemetry(req, res, next);
    });
    router.post('/runs/get_telemetry', auth, TelemetryController.get_telemetry);

    router.post('/runs/get_status', auth, RunController.get_status);
    router.post('/runs/update_status', auth, with_dedup(RunController.update_status));

    router.post('/runs/report_activity', auth, with_dedup(RunEventStreamController.report_activity));
    router.get('/runs/stream', auth, RunEventStreamController.stream);

    router.post('/runs/artifacts/create', auth, RunController.artifacts_create);
}
