import type { Router, RequestHandler } from 'express';
import { with_dedup } from '../../middleware/inbound_dedup.js';
import { ReviewsController } from '../../controllers/reviews_controller.js';

export function register_reviews_routes(router: Router, auth: RequestHandler): void {
    const reviews = new ReviewsController();

    router.post('/reviews/get', auth, reviews.wrap(reviews.get));
    router.post('/reviews/get_by_id', auth, reviews.wrap(reviews.get_by_id));
    router.post('/reviews/create', auth, with_dedup(reviews.wrap(reviews.create)));
    router.post('/reviews/verdict', auth, reviews.wrap(reviews.verdict));
    router.post('/reviews/ack', auth, reviews.wrap(reviews.ack));
    router.post('/reviews/get_messages', auth, reviews.wrap(reviews.get_messages));
    router.post('/reviews/send_message', auth, reviews.wrap(reviews.send_message));
    router.get('/reviews/stream_messages', auth, reviews.wrap(reviews.stream_messages));
}
