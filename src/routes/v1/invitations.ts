import type { Router } from 'express';
import type { Container } from '../../container.js';

export function register_invitations_routes(router: Router, container: Container): void {
    const { invitations_controller } = container;
    router.post('/invitations/create', invitations_controller.create);
    router.post('/invitations/get', invitations_controller.get);
    router.post('/invitations/get_by_id', invitations_controller.get_by_id);
    router.post('/invitations/revoke', invitations_controller.revoke);
    router.post('/invitations/get_by_token', invitations_controller.get_by_token);
    router.post('/invitations/accept', invitations_controller.accept);
}
