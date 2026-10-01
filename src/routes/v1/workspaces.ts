/**
 * Workspaces routes — workspace lookup and removal for the control plane.
 *
 * POST   /v1/workspaces/get
 * POST   /v1/workspaces/get_by_id
 * POST   /v1/workspaces/remove
 */
import type { Router } from 'express';
import { WorkspaceController } from '../../controllers/workspaces_controller.js';

export function register_workspaces_routes(router: Router): void {
    router.post('/workspaces/get', WorkspaceController.get);
    router.post('/workspaces/get_by_id', WorkspaceController.get_by_id);
    router.post('/workspaces/remove', WorkspaceController.remove);
}
