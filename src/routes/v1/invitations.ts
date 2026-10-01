/**
 * Invitations routes — create, look up, revoke, and accept org/team invitations.
 *
 * POST   /v1/invitations/create
 * POST   /v1/invitations/get
 * POST   /v1/invitations/get_by_id
 * POST   /v1/invitations/revoke
 * POST   /v1/invitations/get_by_token
 * POST   /v1/invitations/accept
 */
import type { Router } from 'express';
import type { Container } from '../../container.js';

export function register_invitations_routes(router: Router, container: Container): void {
    const { invitations_controller: c } = container;
    router.post('/invitations/create', c.wrap(c.create));
    router.post('/invitations/get', c.wrap(c.get));
    router.post('/invitations/get_by_id', c.wrap(c.get_by_id));
    router.post('/invitations/revoke', c.wrap(c.revoke));
    router.post('/invitations/get_by_token', c.wrap(c.get_by_token));
    router.post('/invitations/accept', c.wrap(c.accept));
}
