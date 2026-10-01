/**
 * Auth routes — token lifecycle (generate/get/validate/revoke/rotate) and realm dispatch wire keys.
 *
 * POST   /v1/auth/generate_token
 * POST   /v1/auth/get_tokens
 * POST   /v1/auth/validate_token
 * POST   /v1/auth/revoke_token
 * POST   /v1/auth/rotate_token
 * POST   /v1/auth/get_dispatch_public_key
 * POST   /v1/auth/rotate_dispatch_key
 */
import type { Router } from 'express';
import type { Container } from '../../container.js';
import { RealmDispatchKeyController } from '../../controllers/realm_dispatch_key_controller.js';

export function register_dispatch_key_routes(router: Router): void {
    router.post('/auth/get_dispatch_public_key', RealmDispatchKeyController.get_dispatch_public_key);
    router.post('/auth/rotate_dispatch_key', RealmDispatchKeyController.rotate_dispatch_key);
}

/** User/realm/a2a/daemon_wire tokens + dispatch wire keys. */
export function register_auth_routes(
    router: Router,
    container: Container,
): void {
    const { tokens_controller: c } = container;
    router.post('/auth/generate_token', c.wrap(c.generate_token));
    router.post('/auth/get_tokens', c.wrap(c.get_tokens));
    router.post('/auth/validate_token', c.wrap(c.validate_token));
    router.post('/auth/revoke_token', c.wrap(c.revoke_token));
    router.post('/auth/rotate_token', c.wrap(c.rotate_token));
    register_dispatch_key_routes(router);
}
