import { z } from 'zod';

/** POST /v1/reviews/get — list reviews for the caller's inbox. */
export const reviews_get_schema = z.object({
    realm_id: z.string().optional(),
    /**
     * Organization UUID. Required when listing without realm_id.
     * Never invent from X-Org-Id.
     */
    org_id: z.string().uuid().optional().describe(
        'Organization UUID. Required when listing reviews without realm_id.',
    ),
    /** Status values to include. Defaults to ['pending']. */
    statuses: z.array(z.string()).optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
}).superRefine((v, ctx) => {
    // Realm-scoped list — realm_id is SoT.
    if (v.realm_id?.trim()) return;
    if (!v.org_id) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'org_id is required when listing reviews without realm_id',
            path: ['org_id'],
        });
    }
});

/** POST /v1/reviews/get_by_id — single review detail. */
export const reviews_get_by_id_schema = z.object({
    review_id: z.string().min(1),
    /**
     * Required when the caller has no review_notifications row and needs
     * org-scoped `reviews.view` — never invent from X-Org-Id.
     */
    org_id: z.string().uuid().optional().describe(
        'Organization UUID for reviews.view when caller has no notification row.',
    ),
});

/** A reviewer group: a policy (any/all) and a list of channel/username targets. */
export const reviewer_group_schema = z.object({
    policy: z.enum(['any', 'all']),
    channels: z.array(z.string().min(1)).min(1),
});

/** POST /v1/reviews/create — daemon/agent opens a pending human review. */
export const reviews_create_schema = z.object({
    run_id: z.string().min(1),
    daemon_id: z.string().min(1),
    realm_id: z.string().min(1),
    payload: z.record(z.unknown()),
    route_targets: z.array(z.string()).optional(),
    timeout_minutes: z.number().min(1).max(10080).optional(),
    /** Hub-owned reminder interval; null/omit = no Hub reminders. */
    remind_every_minutes: z.number().int().min(1).max(10080).optional(),
    /** Reviewer groups — each group has a policy and list of channel targets. */
    reviewers: z.array(reviewer_group_schema).optional(),
    /** `input_pause` = form without policy (Yamazaki mid-phase inputs). */
    mode: z.enum(['input_pause', 'verdict', 'chat']).optional(),
    /** Initial agent message for chat mode. */
    initial_message: z.string().max(10_000).optional(),
});

/** POST /v1/reviews/verdict — human submits PASS / REJECT / ROUTE:…. */
export const reviews_verdict_schema = z.object({
    review_id: z.string().min(1),
    action: z.string().min(1),
    fields: z.record(z.unknown()).optional(),
    reviewer_name: z.string().optional(),
    /** The review_notifications row ID — required for authorization and audit. */
    notification_id: z.string().min(1),
});

/** POST /v1/reviews/ack — agent acknowledges a decided review. */
export const reviews_ack_schema = z.object({
    review_id: z.string().min(1),
    run_id: z.string().min(1).optional(),
});

/** POST /v1/reviews/get_messages — list chat messages for a review. */
export const reviews_get_messages_schema = z.object({
    review_id: z.string().min(1),
    after_id: z.string().optional(),
});

/**
 * POST /v1/reviews/send_message — human or agent chat message.
 * Speaker is derived from auth (session vs daemon_token).
 * `daemon_id` required when auth_via === daemon_token.
 */
export const reviews_send_message_schema = z.object({
    review_id: z.string().min(1),
    text: z.string().min(1).max(10_000),
    daemon_id: z.string().min(1).optional(),
});

/** GET /v1/reviews/stream_messages query. */
export const reviews_stream_messages_query_schema = z.object({
    review_id: z.string().min(1),
    after_id: z.string().optional(),
});

/** PascalCase aliases (REV-S0 / Agents schema naming). */
export const ReviewsGetInput = reviews_get_schema;
export type ReviewsGetInput = z.infer<typeof reviews_get_schema>;
export const ReviewsGetByIdInput = reviews_get_by_id_schema;
export type ReviewsGetByIdInput = z.infer<typeof reviews_get_by_id_schema>;
export const ReviewsCreateInput = reviews_create_schema;
export type ReviewsCreateInput = z.infer<typeof reviews_create_schema>;
export const ReviewsVerdictInput = reviews_verdict_schema;
export type ReviewsVerdictInput = z.infer<typeof reviews_verdict_schema>;
export const ReviewsAckInput = reviews_ack_schema;
export type ReviewsAckInput = z.infer<typeof reviews_ack_schema>;
export const ReviewsGetMessagesInput = reviews_get_messages_schema;
export type ReviewsGetMessagesInput = z.infer<typeof reviews_get_messages_schema>;
export const ReviewsSendMessageInput = reviews_send_message_schema;
export type ReviewsSendMessageInput = z.infer<typeof reviews_send_message_schema>;
export const ReviewsStreamMessagesQuery = reviews_stream_messages_query_schema;
export type ReviewsStreamMessagesQuery = z.infer<typeof reviews_stream_messages_query_schema>;
