import { z } from 'zod';

/**
 * Canonical wire shape for a review artifact.
 */
export const ReviewArtifactData = z.object({
    id: z.string().uuid()
        .describe('Artifact UUID'),
    phase: z.string().nullable()
        .describe('Phase name this artifact came from; null for run-level artifacts'),
    kind: z.string()
        .describe('Artifact kind (e.g. "file", "image", "text")'),
    name: z.string()
        .describe('Display name of the artifact'),
    mime_type: z.string()
        .describe('MIME type'),
    content: z.string().nullable()
        .describe('Inline content for small artifacts; null for large (use download URL)'),
    content_preview: z.string().nullable()
        .describe('Truncated preview for large artifacts'),
    sequence: z.number().int()
        .describe('Display ordering index'),
});

export type ReviewArtifactData = z.infer<typeof ReviewArtifactData>;

/**
 * Canonical wire shape for a HUG review.
 * Replaces ReviewDto in hug_reviews.service.ts.
 */
export const ReviewData = z.object({
    id: z.string().uuid()
        .describe('Review UUID'),
    run_id: z.string().uuid()
        .describe('Run that triggered this review'),
    run_name: z.string().nullable()
        .describe('Display name of the run; null when not set'),
    daemon_id: z.string().nullable()
        .describe('Daemon that ran the job; null for cloud runs'),
    realm_id: z.string().uuid().nullable()
        .describe('Realm UUID; null for personal runs'),
    realm_name: z.string().nullable()
        .describe('Realm display name'),
    realm_slug: z.string().nullable()
        .describe('Realm slug'),
    org_slug: z.string().nullable()
        .describe('Org slug of the realm; null for personal realms'),
    team: z.string().nullable()
        .describe('Team slug that generated this review'),
    phase: z.string().nullable()
        .describe('Phase name that triggered the review'),
    payload: z.record(z.unknown())
        .describe('Input payload for the review'),
    verdict: z.record(z.unknown()).nullable()
        .describe('Reviewer decision payload; null while pending'),
    status: z.enum(['pending', 'decided', 'completed', 'expired'])
        .describe('Lifecycle status of the review'),
    route_targets: z.array(z.string()).nullable()
        .describe('Notification route targets (usernames, channel IDs)'),
    created_at: z.string()
        .describe('ISO timestamp of review creation'),
    timeout_at: z.string()
        .describe('ISO timestamp when this review expires if not decided'),
    completed_at: z.string().nullable()
        .describe('ISO timestamp of completion; null while pending/decided'),
    claimed_by: z.string().nullable()
        .describe('Username of the reviewer who claimed this; null if unclaimed'),
    claimed_at: z.string().nullable()
        .describe('ISO timestamp of claim; null if unclaimed'),
    message_count: z.number().int()
        .describe('Number of chat messages on this review'),
    artifacts: z.array(ReviewArtifactData)
        .describe('Artifacts submitted with this review'),
});

export type ReviewData = z.infer<typeof ReviewData>;
