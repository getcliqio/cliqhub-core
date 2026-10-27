/**
 * Stored artifacts routes — every file goes through Core; only Core talks to R2 (PLAN-hug-requests §6.6).
 *
 *   POST /v1/artifacts/upload     — stream a file in (daemon: run artifact; responder: Hug file input)
 *   POST /v1/artifacts/download   — stream a file out (token callers)
 *   GET  /v1/artifacts/download   — stream a file out (browser navigation)
 *   POST /v1/artifacts/get        — list artifacts for a run
 *   POST /v1/artifacts/get_by_id  — one artifact's metadata
 *   POST /v1/artifacts/delete     — remove artifact
 */

import type { Router } from 'express';
import { ArtifactsController } from '../../controllers/artifacts_controller.js';

/** Mount `/v1/artifacts/*`. */
export function register_artifacts_routes(router: Router): void {
    const ctrl = new ArtifactsController();

    router.post('/artifacts/upload', ctrl.wrap(ctrl.upload));
    router.post('/artifacts/download', ctrl.wrap(ctrl.download));
    router.get('/artifacts/download', ctrl.wrap(ctrl.download));
    router.post('/artifacts/get', ctrl.wrap(ctrl.get));
    router.post('/artifacts/get_by_id', ctrl.wrap(ctrl.get_by_id));
    router.post('/artifacts/delete', ctrl.wrap(ctrl.delete));
}
