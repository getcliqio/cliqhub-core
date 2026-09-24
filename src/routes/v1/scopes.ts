import type { Router, RequestHandler } from 'express';
import type { Container } from '../../container.js';
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

/** Package namespaces (`/scopes/*`) + control-plane scopes (`/control/scopes/*`). */
export function register_scopes_routes(
    router: Router,
    auth: RequestHandler,
    container: Container,
): void {
    const { scopes_controller } = container;
    router.post('/scopes/get', scopes_controller.get);
    router.post('/scopes/new', scopes_controller.new_scope);
    router.post('/scopes/update', scopes_controller.update);
    router.post('/scopes/delete', scopes_controller.delete_scope);
    router.post('/scopes/add_user', scopes_controller.add_user);
    router.post('/scopes/remove_user', scopes_controller.remove_user);

    register_control_scopes_routes(router, auth);
}
