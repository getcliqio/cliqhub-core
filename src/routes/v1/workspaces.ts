import type { Router, RequestHandler } from 'express';
import { WorkspaceController } from '../../controllers/workspaces_controller.js';

export function register_workspaces_routes(router: Router, auth: RequestHandler): void {
    router.post('/workspaces/get', auth, WorkspaceController.get);
    router.post('/workspaces/get_by_id', auth, WorkspaceController.get_by_id);
    router.post('/workspaces/remove', auth, WorkspaceController.remove);
}
