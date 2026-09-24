import type { Router } from 'express';
import type { Container } from '../../container.js';

export function register_users_routes(router: Router, container: Container): void {
    const { users_controller } = container;
    router.post('/users/get', users_controller.get);
    router.post('/users/get_by_id', users_controller.get_by_id);
    router.post('/users/update', users_controller.update);
}
