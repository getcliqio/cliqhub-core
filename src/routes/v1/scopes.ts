/**
 * Control scopes routes — scope lookup, default management, and add/remove/resolve operations.
 *
 * POST   /v1/control/scopes/get
 * POST   /v1/control/scopes/get_by_id
 * POST   /v1/control/scopes/get_by_slug
 * POST   /v1/control/scopes/get_default
 * POST   /v1/control/scopes/set_default
 * POST   /v1/control/scopes/add
 * POST   /v1/control/scopes/remove
 * POST   /v1/control/scopes/resolve
 */
import type { Router } from 'express';
import { ScopeController } from '../../controllers/control_scopes_controller.js';

export function register_control_scopes_routes(router: Router): void {
    router.post('/control/scopes/get', ScopeController.get);
    router.post('/control/scopes/get_by_id', ScopeController.get_by_id);
    router.post('/control/scopes/get_by_slug', ScopeController.get_by_slug);
    router.post('/control/scopes/get_default', ScopeController.get_default);
    router.post('/control/scopes/set_default', ScopeController.set_default);
    router.post('/control/scopes/add', ScopeController.add);
    router.post('/control/scopes/remove', ScopeController.remove);
    router.post('/control/scopes/resolve', ScopeController.resolve);
}
