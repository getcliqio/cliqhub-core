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
/**
 * Closed catalog of Hub event types (`{domain}.{verb}`).
 * Submit rejects any string not in this list.
 * Notifications (channel delivery) are a side effect of accepted events — later.
 */

export const EVENT_TYPES = [
	'run.started',
	'run.resumed',
	'run.resume_requested',
	'run.completed',
	'run.failed',
	'run.crashed',
	'run.cancelled',
	'phase.started',
	'phase.completed',
	'phase.failed',
	'phase.skipped',
	'phase.escalated',
	'phase.input_required',
	'phase.inputs_supplied',
	'phase.timed_out',
	// Idle watchdog: no progress for threshold — notify only, not a hard fail.
	// Distinct from phase.timed_out (wall-clock cancel). Severity: warn.
	'phase.idle',
	'hug.review_requested',
	'hug.review_reminded',
	'hug.review_responded',
	'hug.routing_requested',
	'hug.review_resolved',
	'hug.review_expired',
	'team.published',
	'team.visibility_changed',
	'daemon.enrolled',
	'daemon.removed',
	'daemon.online',
	'daemon.offline',
	// Daemon outbox alerting — fires on 0→>0 / >0→0 transitions of
	// the daemon's local hub_outbox dead_count. `dead` events carry
	// a compact cause summary so operators can triage without opening
	// the SPA. Emitted best-effort via the outbox itself; loss on a
	// completely-broken daemon is acceptable because `daemon.offline`
	// covers the total-loss case.
	'daemon.outbox.dead',
	'daemon.outbox.recovered',
	'realm.created',
	'realm.deleted',
	'realm.member_added',
	'realm.member_removed',
	'realm.member_role_changed',
	'realm.token_created',
	'realm.token_revoked',
	'realm.key_rotated',
	'auth.api_key_created',
	'auth.api_key_revoked',
	'notification.test',
	'notification.failed',
	// Org-scoped identity events, raised only by CliqHub itself
	// (notifications/org_events.ts); `events/submit` refuses them.
	'invite.owner.sent',
	'invite.owner.reminder',
	'invite.owner.accepted',
	'invite.owner.declined',
	'invite.owner.expired',
	'invite.owner.revoked',
	'invite.org.sent',
	'invite.org.reminder',
	'invite.org.accepted',
	'invite.org.declined',
	'invite.org.expired',
	'invite.org.revoked',
	'invite.realm.sent',
	'invite.realm.reminder',
	'invite.realm.accepted',
	'invite.realm.declined',
	'invite.realm.expired',
	'invite.realm.revoked',
	'org.abandoned',
	'user.setup.sent',
	'user.password_reset.sent',
	'user.password.changed',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EventSeverity = 'info' | 'warn' | 'error' | 'critical';

const TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/** Accepts any cataloged type or any `custom.*` string. */
export function is_event_type(value: string): value is EventType {
	if (TYPE_SET.has(value)) return true;
	return /^custom\..+/.test(value);
}

/** Suggested default severity for presets (not enforced on submit). */
export const EVENT_TYPE_SEVERITY: Record<EventType, EventSeverity> = {
	'run.started': 'info',
	'run.resumed': 'info',
	'run.resume_requested': 'info',
	'run.completed': 'info',
	'run.failed': 'error',
	'run.crashed': 'critical',
	'run.cancelled': 'warn',
	'phase.started': 'info',
	'phase.completed': 'info',
	'phase.failed': 'error',
	'phase.skipped': 'info',
	'phase.escalated': 'error',
	'phase.input_required': 'warn',
	'phase.inputs_supplied': 'info',
	'phase.timed_out': 'error',
	'phase.idle': 'warn',
	'hug.review_requested': 'info',
	'hug.review_reminded': 'info',
	'hug.review_responded': 'info',
	'hug.routing_requested': 'info',
	'hug.review_resolved': 'info',
	'hug.review_expired': 'error',
	'team.published': 'info',
	'team.visibility_changed': 'info',
	'daemon.enrolled': 'info',
	'daemon.removed': 'warn',
	'daemon.online': 'info',
	'daemon.offline': 'warn',
	'daemon.outbox.dead': 'error',
	'daemon.outbox.recovered': 'info',
	'realm.created': 'info',
	'realm.deleted': 'warn',
	'realm.member_added': 'info',
	'realm.member_removed': 'warn',
	'realm.member_role_changed': 'info',
	'realm.token_created': 'warn',
	'realm.token_revoked': 'warn',
	'realm.key_rotated': 'warn',
	'auth.api_key_created': 'warn',
	'auth.api_key_revoked': 'warn',
	'notification.test': 'info',
	'notification.failed': 'error',
	'invite.owner.sent': 'info',
	'invite.owner.reminder': 'info',
	'invite.owner.accepted': 'info',
	'invite.owner.declined': 'info',
	'invite.owner.expired': 'warn',
	'invite.owner.revoked': 'info',
	'invite.org.sent': 'info',
	'invite.org.reminder': 'info',
	'invite.org.accepted': 'info',
	'invite.org.declined': 'info',
	'invite.org.expired': 'warn',
	'invite.org.revoked': 'info',
	'invite.realm.sent': 'info',
	'invite.realm.reminder': 'info',
	'invite.realm.accepted': 'info',
	'invite.realm.declined': 'info',
	'invite.realm.expired': 'warn',
	'invite.realm.revoked': 'info',
	'org.abandoned': 'warn',
	'user.setup.sent': 'info',
	'user.password_reset.sent': 'info',
	'user.password.changed': 'info',
};

/** Families raised only by CliqHub (org events); clients cannot submit them. */
const SYSTEM_EVENT_PREFIXES = ['invite.', 'org.', 'user.'] as const;

/** True for event types only CliqHub raises (invites, org lifecycle, account emails). */
export function is_system_event_type(type: string): boolean {
	return SYSTEM_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}


const non_empty = z.string().trim().min(1);

/**
 * Required top-level submit fields by event family (prefix).
 * Used for fan-out routing context — reject before persist if missing.
 */
export function required_fields_for(type: EventType): readonly string[] {
	if (type.startsWith('run.')) return ['realm_id', 'run_id', 'daemon_id'];
	if (type.startsWith('phase.')) return ['realm_id', 'run_id', 'phase', 'daemon_id'];
	if (type.startsWith('hug.')) return ['realm_id', 'run_id', 'daemon_id'];
	if (type.startsWith('daemon.')) return ['realm_id', 'daemon_id'];
	if (type.startsWith('realm.')) return ['realm_id'];
	if (type.startsWith('team.')) return ['team'];
	if (type.startsWith('custom.')) return ['realm_id'];
	return [];
}

function event_family(type: string): string {
	const dot = type.indexOf('.');
	if (dot <= 0) return type;
	return `${type.slice(0, dot)}.*`;
}

/** Closed Hub catalog (`{domain}.{verb}`). */
export const event_catalog_type_schema = z.enum(EVENT_TYPES);

/** Catalog type or `custom.<name>`. */
export const event_type_schema = z.union([
	event_catalog_type_schema,
	z.string()
		.min(8)
		.regex(/^custom\..+/)
		.describe('Custom event type — must start with custom.'),
]);

/**
 * Open extras bag. Known keys are documented; additional keys are allowed
 * (passthrough) for type-specific notify / triage fields.
 */
export const event_payload_schema = z
	.object({
		notify: z
			.object({
				channels: z
					.union([
						z.literal(false),
						z.array(z.string()),
					])
					.optional()
					.describe('false = mute; string[] = channel refs; omit = default routing'),
			})
			.passthrough()
			.optional()
			.describe('Fan-out intent for Hub notification channels'),
		run_name: z.string().optional().describe('Display name for the run'),
		daemon_name: z.string().optional().describe('Display name for the daemon'),
		error: z.string().optional().describe('Failure / crash message'),
		reason: z.string().optional().describe('Human-readable reason (cancel, escalate, …)'),
		review_id: z.string().optional().describe('HUG review id when applicable'),
		stream_event: z.string().optional().describe('Underlying stream/lifecycle verb'),
		dead_count: z.number().optional().describe('daemon.outbox.dead — dead outbox row count'),
		cause_summary: z.string().optional().describe('Compact outbox dead-cause summary'),
	})
	.passthrough();

export const event_submit_schema = z
	.object({
		type: event_type_schema.describe(
			'Hub catalog type (run.* / phase.* / hug.* / …) or custom.<name>',
		),
		occurred_at: z
			.string()
			.optional()
			.describe('ISO-8601 timestamp; Hub defaults to now when omitted'),
		realm_id: z.string().optional().describe('Required for most families (see family rules)'),
		org_id: z.string().optional().describe('Optional org scope'),
		team: z.string().optional().describe('Team slug; required for team.*'),
		run_id: z.string().optional().describe('Required for run.* / phase.* / hug.*'),
		phase: z.string().optional().describe('Required for phase.*'),
		daemon_id: z.string().optional().describe('Required for run.* / phase.* / hug.* / daemon.*'),
		title: z.string().optional().describe('Short notification title'),
		message: z.string().optional().describe('Longer notification body'),
		severity: z
			.enum(['info', 'warn', 'error', 'critical'])
			.optional()
			.describe('Overrides catalog default severity when set'),
		payload: event_payload_schema
			.optional()
			.describe('Type-specific extras (notify routing, names, error, …)'),
	})
	.superRefine((data, ctx) => {
		if (!is_event_type(data.type)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['type'],
				message:
					`Unknown event type '${data.type}'. `
					+ `Type must be one of the Hub event catalog (${EVENT_TYPES.length} types) `
					+ `or custom.<name>.`,
			});
			return;
		}

		if (is_system_event_type(data.type)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['type'],
				message: `'${data.type}' is raised by CliqHub only and cannot be submitted`,
			});
			return;
		}

		const required = required_fields_for(data.type);
		const family = event_family(data.type);
		for (const field of required) {
			const raw = (data as Record<string, unknown>)[field];
			const parsed = non_empty.safeParse(raw);
			if (parsed.success) continue;
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: [field],
				message: `${field} is required for ${family} events`,
			});
		}
	});

export type EventSubmitBody = z.infer<typeof event_submit_schema>;
