/**
 * Events routes — submit, lookup, built-in type listing, and custom event type CRUD.
 *
 * POST   /v1/events/submit
 * POST   /v1/events/get_by_id
 * POST   /v1/events/types/list
 * POST   /v1/events/custom/list
 * POST   /v1/events/custom/create
 * POST   /v1/events/custom/remove
 */
import type { Router } from 'express';
import { with_dedup } from '../../middleware/inbound_dedup.js';
import { EventsController } from '../../controllers/events_controller.js';

export function register_events_routes(router: Router): void {
    router.post('/events/submit', with_dedup(EventsController.submit));
    router.post('/events/get_by_id', EventsController.get_by_id);
    router.post('/events/types/list', EventsController.types_list);
    router.post('/events/custom/list', EventsController.custom_list);
    router.post('/events/custom/create', EventsController.custom_create);
    router.post('/events/custom/remove', EventsController.custom_remove);
}
