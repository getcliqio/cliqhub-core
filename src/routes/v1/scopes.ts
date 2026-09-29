import type { Router, RequestHandler } from 'express';
import { ScopeController } from '../../controllers/control_scopes_controller.js';

export function register_control_scopes_routes(router: Router, auth: RequestHandler): void {
    router.post('/control/scopes/get', auth, ScopeController.get);
    router.post('/control/scopes/get_by_id', auth, ScopeController.get_by_id);
    router.post('/control/scopes/get_by_slug', auth, ScopeController.get_by_slug);
    router.post('/control/scopes/get_default', auth, ScopeController.get_default);
    router.post('/control/scopes/set_default', auth, ScopeController.set_default);
    router.post('/control/scopes/add', auth, ScopeController.add);
    router.post('/control/scopes/remove', auth, ScopeController.remove);
    router.post('/control/scopes/resolve', auth, ScopeController.resolve);
}
