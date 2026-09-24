import type { Router, RequestHandler } from 'express';
import { with_dedup } from '../../middleware/inbound_dedup.js';
import { ReviewsController } from '../../controllers/reviews_controller.js';

export function register_reviews_routes(router: Router, auth: RequestHandler): void {
    router.post('/reviews/get', auth, ReviewsController.get);
    router.post('/reviews/get_by_id', auth, ReviewsController.get_by_id);
    router.post('/reviews/create', auth, with_dedup(ReviewsController.create));
    router.post('/reviews/verdict', auth, ReviewsController.verdict);
    router.post('/reviews/ack', auth, ReviewsController.ack);
    router.post('/reviews/get_messages', auth, ReviewsController.get_messages);
    router.post('/reviews/send_message', auth, ReviewsController.send_message);
    router.get('/reviews/stream_messages', auth, ReviewsController.stream_messages);
}
