import type { Router, RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { RealmDispatchKeyController } from '../../controllers/realm_dispatch_key_controller.js';

export function register_dispatch_key_routes(router: Router, auth: RequestHandler): void {
    router.post('/auth/get_dispatch_public_key', auth, RealmDispatchKeyController.get_dispatch_public_key);
    router.post('/auth/rotate_dispatch_key', auth, RealmDispatchKeyController.rotate_dispatch_key);
}

/** User/realm/a2a/daemon_wire tokens + dispatch wire keys. */
export function register_auth_routes(
    router: Router,
    auth: RequestHandler,
    container: Container,
): void {
    const { tokens_controller } = container;
    router.post('/auth/generate_token', tokens_controller.generate_token);
    router.post('/auth/get_tokens', tokens_controller.get_tokens);
    router.post('/auth/validate_token', tokens_controller.validate_token);
    router.post('/auth/revoke_token', tokens_controller.revoke_token);
    router.post('/auth/rotate_token', tokens_controller.rotate_token);
    register_dispatch_key_routes(router, auth);
}
