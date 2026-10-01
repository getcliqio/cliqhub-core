/**
 * Reviews routes — human-in-the-loop review lifecycle, messaging, verdict, and SSE message stream.
 *
 * POST   /v1/reviews/get
 * POST   /v1/reviews/get_by_id
 * POST   /v1/reviews/create
 * POST   /v1/reviews/verdict
 * POST   /v1/reviews/ack
 * POST   /v1/reviews/get_messages
 * POST   /v1/reviews/send_message
 * GET    /v1/reviews/stream_messages
 */
import type { Router } from 'express';
import { with_dedup } from '../../middleware/inbound_dedup.js';
import { ReviewsController } from '../../controllers/reviews_controller.js';

export function register_reviews_routes(router: Router): void {
    const reviews = new ReviewsController();

    router.post('/reviews/get', reviews.wrap(reviews.get));
    router.post('/reviews/get_by_id', reviews.wrap(reviews.get_by_id));
    router.post('/reviews/create', with_dedup(reviews.wrap(reviews.create)));
    router.post('/reviews/verdict', reviews.wrap(reviews.verdict));
    router.post('/reviews/ack', reviews.wrap(reviews.ack));
    router.post('/reviews/get_messages', reviews.wrap(reviews.get_messages));
    router.post('/reviews/send_message', reviews.wrap(reviews.send_message));
    router.get('/reviews/stream_messages', reviews.wrap(reviews.stream_messages));
}
