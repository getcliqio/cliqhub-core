import type { Router } from 'express';
import type { Container } from '../../container.js';

export function register_users_routes(router: Router, container: Container): void {
    const { users_controller: c } = container;
    router.post('/users/get', c.wrap(c.get));
    router.post('/users/get_by_id', c.wrap(c.get_by_id));
    router.post('/users/update', c.wrap(c.update));
}
