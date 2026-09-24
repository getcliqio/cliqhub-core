/**
 * Notifications API — response Zod schemas (SoT for OpenAPI / Mintlify).
 *
 * Naming matches inputs: PascalCase value + type with the same name.
 * Every field must have `.describe(…)` (feeds Hub OpenAPI).
 */

import { z } from 'zod';

/** Configured delivery channel on the wire. */
export const NotificationChannelData = z.object({
	id: z.string().describe('Channel UUID'),
	realm_id: z.string().nullable().describe('Owning realm, or null for org/account channels'),
	org_id: z.string().nullable().optional().describe('Owning org for account channels'),
	user_id: z.string().nullable().optional().describe('Owning user for personal account channels'),
	name: z.string().describe('Unique name within the realm or org scope'),
	destinations: z.string().describe('Serialized destination array JSON (built from channel_destinations rows)'),
	enabled: z.number().describe('1 = enabled, 0 = disabled'),
	created_at: z.number().describe('Create time (unix ms)'),
	updated_at: z.number().describe('Last update time (unix ms)'),
	rule_count: z.number().optional().describe('Number of notification rules pointing at this channel'),
});
export type NotificationChannelData = z.infer<typeof NotificationChannelData>;

/** Channel test fire result. */
export const NotificationChannelTestData = z.object({
	delivered: z.number().describe('Count of destinations that accepted the synthetic test'),
	errors: z.array(z.string()).describe('Per-destination error messages (empty when all succeeded)'),
});
export type NotificationChannelTestData = z.infer<typeof NotificationChannelTestData>;

/** Routing rule on the wire. */
export const NotificationRuleData = z.object({
	id: z.string().describe('Rule UUID'),
	realm_id: z.string().nullable().describe('Realm scope, or null for org-global rules'),
	team_slug: z.string().nullable().describe('Team slug under the realm, or null for realm/org-wide'),
	event: z.string().describe('Event selector (exact, family wildcard, or *)'),
	channel_id: z.string().describe('Target channel id'),
	priority: z.number().describe('Priority within the tier'),
	created_at: z.number().describe('Create time (unix ms)'),
	updated_at: z.number().describe('Last update time (unix ms)'),
	tier: z.enum(['global', 'realm']).optional().describe('Present when listing effective (org + realm) rules'),
});
export type NotificationRuleData = z.infer<typeof NotificationRuleData>;

/** In-app inbox row on the wire. */
export const NotificationData = z.object({
	id: z.string().describe('Inbox row UUID'),
	event: z.string().describe('Event type key (e.g. run.failed)'),
	title: z.string().nullable().describe('Short title for the UI'),
	message: z.string().nullable().describe('Body text'),
	realm_id: z.string().nullable().describe('Source realm id, or null for account-scoped rows'),
	realm_slug: z.string().nullable().describe('Resolved realm slug for display (null if realm was deleted)'),
	user_id: z.string().nullable().describe('Target user for per-user notifications; null = realm-wide'),
	team: z.string().nullable().describe('Team slug when the event was team-scoped'),
	run_id: z.string().nullable().describe('Related run id when present'),
	phase: z.string().nullable().describe('Phase name when present'),
	severity: z.string().nullable().describe('Severity (info, warning, error, …)'),
	payload: z.record(z.string(), z.unknown()).describe('Extra payload fields not promoted to columns'),
	created_at: z.number().describe('Create time (unix ms)'),
});
export type NotificationData = z.infer<typeof NotificationData>;

/** Paged inbox payload for `POST /v1/notifications/get`. */
export const NotificationsPagedData = z.object({
	items: z.array(NotificationData).describe('Inbox rows for this page'),
	total: z.number().describe('Total matching rows'),
	offset: z.number().describe('Page offset'),
	limit: z.number().describe('Page size'),
});
export type NotificationsPagedData = z.infer<typeof NotificationsPagedData>;
