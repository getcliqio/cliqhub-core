/**
 * Request schemas for `/v1/hugs/*` (PLAN-hug-requests §6.3). A Hug's own content (prompt, context,
 * requested inputs, channels, expiry, reminders) is validated by cliq-sdk's `HugSpecSchema` in the
 * service — one definition shared with the SDK, cliqd and the UI.
 */

import { z } from 'zod';

/** POST /v1/hugs/get — the caller's Hugs (inbox). Org-scoped list requires org_id; never invented from a header. */
export const HugsGetInput = z.object({
    realm_id: z.string().optional(),
    org_id: z.string().uuid().optional().describe('Organization UUID. Required when listing without realm_id.'),
    /** Status values to include. Defaults to ['open']. */
    statuses: z.array(z.enum(['open', 'closed', 'expired', 'cancelled'])).optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
}).superRefine((v, ctx) => {
    if (v.realm_id?.trim() || v.org_id) return;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'org_id is required when listing Hugs without realm_id', path: ['org_id'] });
});
export type HugsGetInput = z.infer<typeof HugsGetInput>;

/** POST /v1/hugs/get_by_id — one Hug with its responses. */
export const HugsGetByIdInput = z.object({
    hug_id: z.string().min(1),
});
export type HugsGetByIdInput = z.infer<typeof HugsGetByIdInput>;

/** POST /v1/hugs/create — cliqd opens a Hug for one phase iteration. */
export const HugsCreateInput = z.object({
    /** Daemon-minted id; a retried create adopts it (§9). */
    hug_id: z.string().min(1).max(100).optional(),
    run_id: z.string().min(1),
    daemon_id: z.string().min(1),
    realm_id: z.string().min(1),
    phase: z.string().min(1),
    iteration: z.number().int().nonnegative().default(0),
    /** The agent's HugSpec (cliq-sdk), validated by the service. */
    spec: z.record(z.unknown()),
});
export type HugsCreateInput = z.infer<typeof HugsCreateInput>;

/** POST /v1/hugs/respond — a person submits (or replaces) their response. */
export const HugsRespondInput = z.object({
    hug_id: z.string().min(1),
    /** Values keyed by requested-input name; file inputs take `{ artifact_id }` from artifacts/upload. */
    values: z.record(z.unknown()),
    comment: z.string().max(10_000).optional(),
});
export type HugsRespondInput = z.infer<typeof HugsRespondInput>;

/** POST /v1/hugs/close — the requester ends the Hug with its outcome. */
export const HugsCloseInput = z.object({
    hug_id: z.string().min(1),
    outcome: z.string().max(2_000),
    /** The daemon closing it — must be the one that opened it. */
    daemon_id: z.string().min(1),
});
export type HugsCloseInput = z.infer<typeof HugsCloseInput>;

/** POST /v1/hugs/get_events — cliqd catches up on its Hugs' events (§9.4). */
export const HugsGetEventsInput = z.object({
    daemon_id: z.string().min(1),
    cursors: z.array(z.object({
        hug_id: z.string().min(1),
        after_seq: z.number().int().nonnegative(),
    })).max(500),
});
export type HugsGetEventsInput = z.infer<typeof HugsGetEventsInput>;
