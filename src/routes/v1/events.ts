import type { Router, RequestHandler } from 'express';
import { with_dedup } from '../../middleware/inbound_dedup.js';
import { EventsController } from '../../controllers/events_controller.js';

export function register_events_routes(router: Router, auth: RequestHandler): void {
    router.post('/events/submit', auth, with_dedup(EventsController.submit));
    router.post('/events/get_by_id', auth, EventsController.get_by_id);
    router.post('/events/types/list', auth, EventsController.types_list);
    router.post('/events/custom/list', auth, EventsController.custom_list);
    router.post('/events/custom/create', auth, EventsController.custom_create);
    router.post('/events/custom/remove', auth, EventsController.custom_remove);
}
