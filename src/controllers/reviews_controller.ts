/**
 * Reviews Hub resource — REV-ORG invent + REV-S0 MVC structure.
 *
 * POST /v1/reviews/get: body `org_id` required unless `realm_id`.
 * Never invent org from X-Org-Id / current_org_id.
 * get_by_id permission fallback also requires body `org_id` (no header invent).
 * Envelope stays flat until a future REV-ENV slice.
 */

import type { Request } from 'express';
import { BaseController } from './base_controller.js';
import { ApiError } from '../lib/api_error.js';
import { HugReviewsService } from '../services/hug_reviews.service.js';
import { ReviewMessageService } from '../services/review_message.service.js';
import { ReviewPendingService } from '../services/review_pending.service.js';
import { require_permission } from '../auth/permissions.js';
import { Realm } from '../models/index.js';
import type { AuthContext } from '../types/vo.js';
import type { FlatApiOkResponse, FlatApiRequest } from '../types/api_response.js';
import {
    ReviewsGetInput,
    ReviewsGetByIdInput,
    ReviewsCreateInput,
    ReviewsVerdictInput,
    ReviewsAckInput,
    ReviewsGetMessagesInput,
    ReviewsSendMessageInput,
    ReviewsStreamMessagesQuery,
} from '../schemas/reviews_schemas.js';

type ReviewsFields = Record<string, unknown>;

export class ReviewsController extends BaseController {
    /**
     * Bearer must be allowed to act on `org_id`.
     * PAT/session: org_id ∈ auth.org_ids. Daemon token: realm.org_id === org_id.
     * Site hub admin may act on any org_id.
     */
    private async assert_org_authorized(auth: AuthContext | undefined, org_id: string): Promise<void> {
        // No credential context — refuse rather than invent tenancy.
        if (!auth) {
            throw ApiError.unauthorized('authentication required');
        }

        // Site admin may target any org.
        if (auth.user?.role === 'admin') return;

        // Daemon tokens are realm-bound; tenancy is the realm's org.
        if (auth.auth_via === 'daemon_token') {
            if (!auth.realm_id) {
                throw ApiError.forbidden('daemon token has no realm binding');
            }
            const realm = await Realm.findByPk(auth.realm_id);
            if (!realm || realm.org_id !== org_id) {
                throw ApiError.forbidden('org_id does not match daemon realm organization');
            }
            return;
        }

        // PAT / session: live membership list from auth middleware.
        if (!auth.org_ids.includes(org_id)) {
            throw ApiError.forbidden('not a member of the requested organization');
        }
    }

    private auth_from(req: Request): AuthContext | undefined {
        return req.auth;
    }

    /**
     * POST /v1/reviews/get — list open HUG reviews for caller's notifications.
     * Org-scoped list requires body `org_id` (REV-ORG hard-cut).
     *
     * @param req - Body: {@link ReviewsGetInput}
     * @param res - Flat `{ ok: true, reviews, total, offset, limit }`
     */
    async get(
        req: FlatApiRequest<ReviewsGetInput, ReviewsFields>,
        res: FlatApiOkResponse<ReviewsFields>,
    ): Promise<void> {
        // Session user is mandatory for inbox listing.
        const user_id = req.user?.user_id?.trim();
        if (!user_id) throw ApiError.unauthorized('Authentication required');

        // Zod SoT — org-scoped list requires org_id; never invent from X-Org-Id.
        const body = this.parse_body(ReviewsGetInput, req);
        let org_id: string | undefined;
        if (body.org_id) {
            await this.assert_org_authorized(this.auth_from(req), body.org_id);
            org_id = body.org_id;
        }

        const result = await ReviewPendingService.list_for_user({
            user_id,
            realm_id: body.realm_id,
            org_id,
            statuses: body.statuses,
            limit: body.limit,
            offset: body.offset,
        });

        // Flat envelope — fields at top level (not this.ok / { ok, data }).
        res.json({
            ok: true,
            reviews: result.reviews,
            total: result.total,
            offset: body.offset ?? 0,
            limit: body.limit ?? 50,
        });
    }

    /**
     * POST /v1/reviews/create — daemon/agent creates a pending human review.
     *
     * @param req - Body: {@link ReviewsCreateInput}
     * @param res - Flat `{ ok: true, data }` with 201
     */
    async create(
        req: FlatApiRequest<ReviewsCreateInput, ReviewsFields>,
        res: FlatApiOkResponse<ReviewsFields>,
    ): Promise<void> {
        const user_id = req.user?.user_id?.trim();
        if (!user_id) throw ApiError.unauthorized('Authentication required');

        const body = this.parse_body(ReviewsCreateInput, req);

        // Org tenancy follows the review's realm — not invent from headers.
        const realm = await Realm.findByPk(body.realm_id, { attributes: ['org_id'] });
        const org_id = realm?.org_id ?? null;

        const data = await HugReviewsService.create({
            run_id: body.run_id,
            daemon_id: body.daemon_id,
            realm_id: body.realm_id,
            payload: body.payload,
            route_targets: body.route_targets,
            timeout_minutes: body.timeout_minutes ?? 240,
            remind_every_minutes: body.remind_every_minutes ?? null,
            actor_id: user_id,
            reviewers: body.reviewers ?? [],
            org_id,
            mode: body.mode,
            initial_message: body.initial_message,
        });
        res.status(201).json({ ok: true, data });
    }

    /**
     * POST /v1/reviews/get_by_id — review detail (agent poll + Hub UI).
     * When caller has no notification row, body `org_id` is required for reviews.view.
     *
     * @param req - Body: {@link ReviewsGetByIdInput}
     * @param res - Flat `{ ok: true, data }`
     */
    async get_by_id(
        req: FlatApiRequest<ReviewsGetByIdInput, ReviewsFields>,
        res: FlatApiOkResponse<ReviewsFields>,
    ): Promise<void> {
        const body = this.parse_body(ReviewsGetByIdInput, req);

        // Daemon tokens poll without a notification row — skip user/org path.
        if (req.auth?.auth_via === 'daemon_token') {
            const data = await HugReviewsService.get(body.review_id);
            res.json({ ok: true, data });
            return;
        }

        const user_id = req.user?.user_id?.trim();
        if (!user_id) throw ApiError.unauthorized('Authentication required');

        const has_notification = await HugReviewsService.has_notification_for_user(
            body.review_id, user_id,
        );

        if (!has_notification) {
            // No invent from X-Org-Id — body org_id is SoT for permission path.
            if (!body.org_id) {
                throw ApiError.forbidden('org_id is required to view a review without a notification');
            }
            await this.assert_org_authorized(this.auth_from(req), body.org_id);
            const hub_user = req.auth?.user;
            await require_permission(
                body.org_id, user_id, 'reviews.view',
                { site_role: hub_user?.role },
            );
        }

        const data = await HugReviewsService.get(body.review_id);
        res.json({ ok: true, data });
    }

    /**
     * POST /v1/reviews/verdict — human submits PASS / REJECT / ROUTE:….
     *
     * @param req - Body: {@link ReviewsVerdictInput}
     * @param res - Flat `{ ok: true, data }`
     */
    async verdict(
        req: FlatApiRequest<ReviewsVerdictInput, ReviewsFields>,
        res: FlatApiOkResponse<ReviewsFields>,
    ): Promise<void> {
        const user_id = req.user?.user_id?.trim();
        if (!user_id) throw ApiError.unauthorized('Authentication required');

        const body = this.parse_body(ReviewsVerdictInput, req);

        // Notification ownership gates who may decide this review.
        await HugReviewsService.authorize_verdict_via_notification(
            body.notification_id, body.review_id, user_id,
        );

        const data = await HugReviewsService.submit_verdict({
            review_id: body.review_id,
            action: body.action,
            fields: body.fields,
            reviewer_name: body.reviewer_name,
            actor_id: user_id,
            notification_id: body.notification_id,
            responded_by: user_id,
        });
        res.json({ ok: true, data });
    }

    /**
     * POST /v1/reviews/ack — agent acknowledges a decided review.
     *
     * @param req - Body: {@link ReviewsAckInput}
     * @param res - Flat `{ ok: true, data }`
     */
    async ack(
        req: FlatApiRequest<ReviewsAckInput, ReviewsFields>,
        res: FlatApiOkResponse<ReviewsFields>,
    ): Promise<void> {
        const user_id = req.user?.user_id?.trim();
        if (!user_id) throw ApiError.unauthorized('Authentication required');

        const body = this.parse_body(ReviewsAckInput, req);
        // Prefer body run_id; fall back to the review row when agent omits it.
        const review = await HugReviewsService.get(body.review_id);
        const run_id = body.run_id ?? review.run_id;
        const data = await HugReviewsService.ack(body.review_id, run_id);
        res.json({ ok: true, data });
    }

    /**
     * POST /v1/reviews/send_message — human or agent chat message.
     * Speaker from auth: session → user message; daemon_token → agent message.
     *
     * @param req - Body: {@link ReviewsSendMessageInput}
     * @param res - Flat `{ ok: true, data }`
     */
    async send_message(
        req: FlatApiRequest<ReviewsSendMessageInput, ReviewsFields>,
        res: FlatApiOkResponse<ReviewsFields>,
    ): Promise<void> {
        const body = this.parse_body(ReviewsSendMessageInput, req);

        // Daemon path: speaker is the agent (daemon_id required).
        if (req.auth?.auth_via === 'daemon_token') {
            const daemon_id = (body.daemon_id ?? '').trim();
            if (!daemon_id) throw ApiError.bad_request('daemon_id is required');
            const msg = await ReviewMessageService.send_agent_message(
                body.review_id, daemon_id, body.text,
            );
            res.json({ ok: true, data: msg });
            return;
        }

        const user_id = req.user?.user_id?.trim();
        if (!user_id) throw ApiError.unauthorized('Authentication required');

        const msg = await ReviewMessageService.send_user_message(
            body.review_id, user_id, body.text,
        );
        res.json({ ok: true, data: msg });
    }

    /**
     * POST /v1/reviews/get_messages — list messages for a review.
     *
     * @param req - Body: {@link ReviewsGetMessagesInput}
     * @param res - Flat `{ ok: true, data: { messages } }`
     */
    async get_messages(
        req: FlatApiRequest<ReviewsGetMessagesInput, ReviewsFields>,
        res: FlatApiOkResponse<ReviewsFields>,
    ): Promise<void> {
        const user_id = req.user?.user_id?.trim();
        if (!user_id) throw ApiError.unauthorized('Authentication required');

        const body = this.parse_body(ReviewsGetMessagesInput, req);
        const messages = await ReviewMessageService.list_messages(
            body.review_id, body.after_id,
        );
        res.json({ ok: true, data: { messages } });
    }

    /**
     * GET /v1/reviews/stream_messages?review_id=...&after_id=...
     * Server-Sent Events for live chat messages.
     *
     * @param req - Query: {@link ReviewsStreamMessagesQuery}
     * @param res - text/event-stream
     */
    async stream_messages(
        req: FlatApiRequest<Record<string, never>, ReviewsFields>,
        res: FlatApiOkResponse<ReviewsFields>,
    ): Promise<void> {
        const user_id = req.user?.user_id?.trim();
        if (!user_id) throw ApiError.unauthorized('Authentication required');

        // Query SoT — not body; parse against the shared Zod schema.
        const parsed = ReviewsStreamMessagesQuery.parse({
            review_id: req.query['review_id'],
            after_id: req.query['after_id'] || undefined,
        });

        let last_id = parsed.after_id;

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();

        res.write(': connected\n\n');

        let closed = false;
        req.on('close', () => { closed = true; });

        const POLL_MS = 2_000;
        const MAX_DURATION_MS = 5 * 60_000;
        const deadline = Date.now() + MAX_DURATION_MS;

        // Poll until client disconnects or the stream budget expires.
        while (!closed && Date.now() < deadline) {
            const messages = await ReviewMessageService.list_messages(
                parsed.review_id, last_id,
            );
            for (const msg of messages) {
                if (closed) break;
                res.write(`data: ${JSON.stringify(msg)}\n\n`);
                last_id = msg.id;
            }
            if (closed) break;
            await new Promise((r) => setTimeout(r, POLL_MS));
        }

        if (!closed) {
            res.write('event: timeout\ndata: reconnect\n\n');
        }
        res.end();
    }
}
