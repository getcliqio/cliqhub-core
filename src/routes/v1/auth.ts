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
    const { tokens_controller: c } = container;
    router.post('/auth/generate_token', c.wrap(c.generate_token));
    router.post('/auth/get_tokens', c.wrap(c.get_tokens));
    router.post('/auth/validate_token', c.wrap(c.validate_token));
    router.post('/auth/revoke_token', c.wrap(c.revoke_token));
    router.post('/auth/rotate_token', c.wrap(c.rotate_token));
    register_dispatch_key_routes(router, auth);
}
