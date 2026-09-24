/**
 * Zod request body for POST /v1/events/submit.
 * Kept OpenAPI-friendly: catalog enum on `type`, documented `payload` shape.
 */

import { z } from 'zod';

import { EVENT_TYPES, is_event_type, type EventType } from './types.js';

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
