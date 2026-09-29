import { z } from 'zod';

/**
 * Canonical wire shape for a submitted event.
 * Replaces inline SubmittedEvent in events/submit.service.ts.
 * created_at is epoch ms (matching the service).
 */
export const EventData = z.object({
    id: z.string().uuid()
        .describe('Event UUID'),
    type: z.string()
        .describe('Event type slug (e.g. "run.completed", "review.requested")'),
    occurred_at: z.string()
        .describe('ISO timestamp of when the event occurred'),
    realm_id: z.string().uuid().nullable()
        .describe('Realm context; null for org-level or global events'),
    org_id: z.string().uuid().nullable()
        .describe('Org context; null for personal events'),
    team: z.string().nullable()
        .describe('Team slug that generated this event'),
    run_id: z.string().uuid().nullable()
        .describe('Run UUID if this event relates to a run'),
    phase: z.string().nullable()
        .describe('Phase name if this event relates to a specific phase'),
    daemon_id: z.string().nullable()
        .describe('Daemon that processed this event; null for cloud'),
    title: z.string().nullable()
        .describe('Short human-readable title'),
    message: z.string().nullable()
        .describe('Longer description or body'),
    severity: z.enum(['info', 'warn', 'error', 'critical'])
        .describe('Event severity level'),
    payload: z.record(z.unknown())
        .describe('Structured event payload'),
    actor_id: z.string().uuid().nullable()
        .describe('UUID of the user or service that triggered this event'),
    created_at: z.number()
        .describe('Epoch ms when the event record was created'),
});

export type EventData = z.infer<typeof EventData>;

/**
 * Custom event type definition (declared or observed).
 */
export const CustomEventData = z.object({
    id: z.string().uuid()
        .describe('Custom event type UUID'),
    event_type: z.string()
        .describe('Unique event type slug'),
    source: z.enum(['declared', 'observed'])
        .describe('"declared" = explicitly registered; "observed" = auto-detected from payloads'),
    realm_id: z.string().uuid().nullable()
        .describe('Realm scope; null for org-wide types'),
    team_slug: z.string().nullable()
        .describe('Team that declared this type; null for org-level'),
    label: z.string().nullable()
        .describe('Human-readable label'),
    created_at: z.number()
        .describe('Epoch ms of registration'),
});

export type CustomEventData = z.infer<typeof CustomEventData>;
