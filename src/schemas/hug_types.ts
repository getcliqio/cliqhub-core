/**
 * Request schemas for `/v1/hugs/*` (PLAN-hug-requests §6.3) and `/v1/hug_bundles/*` (PLAN-hug-widgets §11.1).
 *
 * A Hug's envelope ({@link HugEnvelopeSchema}) is Core's own: which hug (name and bundle hash), the
 * title and summary, the upload slots, the attachments, channels, expiry and reminders. `params` and
 * answer `values` are the hug's — Core checks only their shape and size, never their meaning.
 */

import { z } from 'zod';

/** Largest serialized `params` or answer `values`. */
export const MAX_HUG_JSON_BYTES = 256 * 1024;
/** Longest Hug summary (notifications, the inbox). */
export const MAX_HUG_SUMMARY = 2_000;
/** Longest response summary (one line). */
export const MAX_RESPONSE_SUMMARY = 120;
/** Hug names: lowercase letters, digits and `-` (as cliq-sdk's `HUG_NAME_RE`). */
const HUG_NAME = /^[a-z][a-z0-9-]{0,63}$/;

const json_object_within = (label: string) => z.record(z.string(), z.unknown()).refine(
    (v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= MAX_HUG_JSON_BYTES,
    `${label} is larger than ${MAX_HUG_JSON_BYTES / 1024} KB`,
);

/** An upload slot: a top-level answer key that may carry this person's uploads. */
export const HugFileSlotSchema = z.object({
    name: z.string().min(1).max(64),
    accept: z.array(z.string().min(1).max(100)).max(50).optional(),
    max_bytes: z.number().int().min(1).optional(),
    multiple: z.boolean().optional(),
    required: z.boolean().optional(),
}).strict();
export type HugFileSlot = z.infer<typeof HugFileSlotSchema>;

/** A run file the hug's frontend may read. */
export const HugAttachmentSchema = z.object({
    artifact_id: z.string().min(1),
    name: z.string().min(1).max(500),
    size: z.number().int().min(0),
    content_type: z.string().min(1).max(200),
    sha256: z.string().max(64),
}).strict();
export type HugAttachment = z.infer<typeof HugAttachmentSchema>;

/** The Hug a daemon opens (`spec` of `hugs/create`). */
export const HugEnvelopeSchema = z.object({
    hug: z.object({
        name: z.string().regex(HUG_NAME, 'must be lowercase letters, digits and -'),
        sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 (hex)'),
    }).strict(),
    title: z.string().min(1).max(200),
    summary: z.string().max(MAX_HUG_SUMMARY).optional(),
    params: json_object_within('params').default({}),
    files: z.array(HugFileSlotSchema).max(50).default([]),
    attachments: z.array(HugAttachmentSchema).max(100).default([]),
    channels: z.array(z.string().min(1)).optional(),
    expires_in_min: z.number().min(1).max(10_080).optional(),
    reminders: z.object({
        every_min: z.number().min(5).max(10_080).optional(),
        at_min: z.array(z.number().min(1).max(10_080)).max(10).optional(),
    }).strict().optional(),
}).strict().superRefine((spec, ctx) => {
    const names = spec.files.map((f) => f.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `the upload slot '${dup}' is listed twice`, path: ['files'] });
});
export type HugEnvelope = z.infer<typeof HugEnvelopeSchema>;

/** A hug's built `dist/`, sent on the retry after `BUNDLE_MISSING`: path → text. */
export const HugBundleUploadSchema = z.object({
    files: z.record(z.string().min(1).max(300), z.string()),
});

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
    /** The Hug's envelope ({@link HugEnvelopeSchema}), validated by the service. */
    spec: z.record(z.unknown()),
    /** The hug's bundle — only on the retry after 409 `BUNDLE_MISSING`. */
    bundle: HugBundleUploadSchema.optional(),
});
export type HugsCreateInput = z.infer<typeof HugsCreateInput>;

/** POST /v1/hugs/respond — a person submits (or replaces) their response. */
export const HugsRespondInput = z.object({
    hug_id: z.string().min(1),
    /** The answer, as the hug's keys (≤ 256 KB); an upload slot's key takes `{ artifact_id }` (or a list) from artifacts/upload. */
    values: json_object_within('values'),
    /** The answer in one line, written by the hug's frontend. */
    summary: z.string().max(MAX_RESPONSE_SUMMARY).refine((s) => !/[\r\n]/.test(s), 'summary is one line').optional(),
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

/** POST /v1/hug_bundles/get_file — one file of a stored hug bundle (public: code named by its hash). */
export const HugBundlesGetFileInput = z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    path: z.string().min(1).max(300),
});
export type HugBundlesGetFileInput = z.infer<typeof HugBundlesGetFileInput>;
