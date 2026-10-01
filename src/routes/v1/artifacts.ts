/**
 * Stored artifacts routes — durable file storage for run outputs.
 *
 *   POST /v1/artifacts/submit     — daemon uploads artifact to R2
 *   POST /v1/artifacts/get        — list artifacts for a run
 *   POST /v1/artifacts/get_by_id  — single artifact + presigned URL
 *   POST /v1/artifacts/delete     — remove artifact
 */

import type { Router } from 'express';
import { ArtifactsController } from '../../controllers/artifacts_controller.js';

export function register_artifacts_routes(router: Router): void {
    const ctrl = new ArtifactsController();

    router.post('/artifacts/submit', ctrl.wrap(ctrl.submit));
    router.post('/artifacts/get', ctrl.wrap(ctrl.get));
    router.post('/artifacts/get_by_id', ctrl.wrap(ctrl.get_by_id));
    router.post('/artifacts/delete', ctrl.wrap(ctrl.delete));
}
