/**
 * Notifications API — Zod request schemas (SoT for inbound bodies).
 * Every field must have `.describe(…)` (feeds Hub OpenAPI / Mintlify).
 *
 * Tenancy (NTF-ORG): account invent / org rules / inbox require body `org_id`.
 * Never invent from X-Org-Id / current_org_id. Realm-scoped ops use `realm_id`.
 */

import { z } from 'zod';

import { destination_schema } from '../notifications/channel_config.js';
import { is_recipient_selector } from '../notifications/recipients.js';

const org_id_field = z.string().uuid().describe(
    'Organization this call targets. Required for account-scoped channel/rule ops and inbox. '
    + 'Caller must be authorized for this org via the Bearer credential.',
);

/** POST /v1/notification_channels/get */
export const NotificationChannelsGetInput = z.object({
    org_id: org_id_field.optional(),
    realm_id: z.string().min(1).optional().describe('Realm to list channels for; omit (or set account) for org/account channels'),
    account: z.boolean().optional().describe('When true, list account-owned channels (realm_id must be null/omitted)'),
    enabled: z.boolean().optional().describe('When true, only return enabled channels'),
    ids: z.array(z.string()).optional().describe('Optional id set; with enabled=true, resolves those ids then filters to the realm'),
    query: z.string().optional().describe('Substring match on channel name'),
}).superRefine((data, ctx) => {
    const has_realm = Boolean(data.realm_id?.trim());
    const want_account = data.account === true || !has_realm;
    if (want_account && has_realm) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['realm_id'],
            message: 'Do not set realm_id when listing account channels',
        });
    }
    // Account list: body.org_id is invent SoT (never X-Org-Id).
    if (want_account && !data.org_id) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['org_id'],
            message: 'org_id is required when listing account channels',
        });
    }
});
export type NotificationChannelsGetInput = z.infer<typeof NotificationChannelsGetInput>;

/** POST /v1/notification_channels/create */
export const NotificationChannelsCreateInput = z.object({
    org_id: org_id_field.optional(),
    realm_id: z.string().min(1).optional().describe('When set, create a realm channel; omit for an org/account channel'),
    name: z.string().describe('Unique channel name within the realm or org scope'),
    destinations: z.array(destination_schema).min(1).describe('One or more delivery destinations (slack, email, webhook, cliqhub, channel_ref, …)'),
    enabled: z.boolean().optional().describe('When false, channel is created disabled (default enabled)'),
}).superRefine((data, ctx) => {
    const has_realm = Boolean(data.realm_id?.trim());
    // Account create: body.org_id required; never invent from header.
    if (!has_realm && !data.org_id) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['org_id'],
            message: 'org_id is required when creating an account channel',
        });
    }
});
export type NotificationChannelsCreateInput = z.infer<typeof NotificationChannelsCreateInput>;

/** POST /v1/notification_channels/update */
export const NotificationChannelsUpdateInput = z.object({
    id: z.string().describe('Channel id to update'),
    name: z.string().optional().describe('New name (must remain unique in scope)'),
    destinations: z.array(destination_schema).min(1).optional().describe('Replace the full destinations list when set'),
    enabled: z.boolean().optional().describe('Enable or disable the channel'),
});
export type NotificationChannelsUpdateInput = z.infer<typeof NotificationChannelsUpdateInput>;

/** POST /v1/notification_channels/remove */
export const NotificationChannelsRemoveInput = z.object({
    id: z.string().describe('Channel id to delete'),
});
export type NotificationChannelsRemoveInput = z.infer<typeof NotificationChannelsRemoveInput>;

/** POST /v1/notification_channels/test */
export const NotificationChannelsTestInput = z.object({
    id: z.string().describe('Channel id to test'),
    destination_index: z.number().int().nonnegative().optional().describe('When set, only fire that destination index (0-based)'),
});
export type NotificationChannelsTestInput = z.infer<typeof NotificationChannelsTestInput>;

/** POST /v1/orgs|realms/get_notification_rules */
export const NotificationRulesListInput = z.object({
    org_id: org_id_field.optional(),
    realm_id: z.string().min(1).optional().describe('When set, list realm (and optional team) rules; omit for org-global rules'),
    team_slug: z.string().min(1).optional().describe('When set with realm_id, filter to team-scoped rules'),
    effective: z.boolean().optional().describe('When true with realm_id, merge org + realm tiers for what actually fires'),
}).superRefine((data, ctx) => {
    const has_realm = Boolean(data.realm_id?.trim());
    // Org-global list (no realm): body.org_id required.
    if (!has_realm && !data.org_id) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['org_id'],
            message: 'org_id is required when listing org-global notification rules',
        });
    }
});
export type NotificationRulesListInput = z.infer<typeof NotificationRulesListInput>;

/** POST /v1/orgs|realms/set_notification_rules */
export const NotificationRulesSetInput = z.object({
    org_id: org_id_field.optional(),
    realm_id: z.string().min(1).optional().describe('When set, upsert a realm/team rule; omit for org-global'),
    team_slug: z.string().min(1).optional().describe('Optional team scope under the realm'),
    event: z.string().min(1).describe('Event selector (exact type, family wildcard like run.*, or *)'),
    channel_id: z.string().min(1).describe('Target notification channel id'),
    priority: z.number().int().optional().describe('Rule priority (higher wins within a tier when supported)'),
    recipients: z.array(z.string().refine(is_recipient_selector, 'Not a recipient selector (invitee, org_owners, inviter, user or a user id)'))
        .nullable().optional()
        .describe('Who receives it: invitee | org_owners | inviter | user | user ids; null = the channel destinations; omit to keep'),
}).superRefine((data, ctx) => {
    const has_realm = Boolean(data.realm_id?.trim());
    if (!has_realm && !data.org_id) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['org_id'],
            message: 'org_id is required when setting an org-global notification rule',
        });
    }
});
export type NotificationRulesSetInput = z.infer<typeof NotificationRulesSetInput>;

/** POST /v1/orgs|realms/remove_notification_rules */
export const NotificationRulesRemoveInput = z.object({
    id: z.string().uuid().describe('Rule UUID to delete'),
});
export type NotificationRulesRemoveInput = z.infer<typeof NotificationRulesRemoveInput>;

/** POST /v1/notifications/get */
export const NotificationsGetInput = z.object({
    org_id: org_id_field.describe(
        'Organization that bounds the inbox. Required — never invent from X-Org-Id.',
    ),
    realm_id: z.string().optional().describe('Legacy single-realm filter (intersected with membership)'),
    realms: z.array(z.string()).optional().describe('Multi-select realm filter (ids); intersected with membership'),
    types: z.array(z.string()).optional().describe('Filter by event type strings'),
    severities: z.array(z.string()).optional().describe('Filter by severity values'),
    teams: z.array(z.string()).optional().describe('Filter by team slug'),
    run_id: z.string().optional().describe('Filter to a single run id'),
    phases: z.array(z.string()).optional().describe('Filter by phase name'),
    q: z.string().optional().describe('Substring search across title, message, event, team, run_id'),
    since_ms: z.number().optional().describe('Inclusive lower bound on created_at (unix ms)'),
    until_ms: z.number().optional().describe('Inclusive upper bound on created_at (unix ms)'),
    initiated_by_me: z.boolean().optional().describe('When true, only events for runs the caller started'),
    limit: z.number().int().positive().optional().describe('Page size (default 50, max 100)'),
    offset: z.number().int().nonnegative().optional().describe('Page offset (default 0)'),
});
export type NotificationsGetInput = z.infer<typeof NotificationsGetInput>;

/**
 * Notifications API — response Zod schemas (SoT for OpenAPI / Mintlify).
 *
 * Naming matches inputs: PascalCase value + type with the same name.
 * Every field must have `.describe(…)` (feeds Hub OpenAPI).
 */

/** Configured delivery channel on the wire. */
export const NotificationChannelData = z.object({
	id: z.string().describe('Channel UUID'),
	realm_id: z.string().nullable().describe('Owning realm, or null for org/account channels'),
	org_id: z.string().nullable().optional().describe('Owning org for account channels'),
	user_id: z.string().nullable().optional().describe('Owning user for personal account channels'),
	name: z.string().describe('Unique name within the realm or org scope'),
	destinations: z.array(destination_schema).describe('Delivery destinations — typed array where each item has a fixed `type` (slack | email | webhook | http | jira | cliqhub | channel_ref) and type-specific required fields'),
	enabled: z.number().describe('1 = enabled, 0 = disabled'),
	created_at: z.number().describe('Create time (unix ms)'),
	updated_at: z.number().describe('Last update time (unix ms)'),
	rule_count: z.number().optional().describe('Number of notification rules pointing at this channel'),
	system_key: z.string().nullable().describe('Stable key of a channel CliqHub seeded (e.g. org.email), else null'),
	locked: z.boolean().describe('True when the channel cannot be changed or removed (409 locked)'),
	lock_reason: z.string().nullable().describe('Why the channel is locked'),
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
	org_id: z.string().nullable().optional().describe('Owning org for org-global rules'),
	team_slug: z.string().nullable().describe('Team slug under the realm, or null for realm/org-wide'),
	event: z.string().describe('Event selector (exact, family wildcard, or *)'),
	channel_id: z.string().describe('Target channel id'),
	priority: z.number().describe('Priority within the tier'),
	created_at: z.number().describe('Create time (unix ms)'),
	updated_at: z.number().describe('Last update time (unix ms)'),
	tier: z.enum(['global', 'realm']).optional().describe('Present when listing effective (org + realm) rules'),
	recipients: z.array(z.string()).nullable().describe('Who receives it: invitee | org_owners | inviter | user | user ids; null = the channel destinations'),
	system_key: z.string().nullable().describe('Stable key of a rule CliqHub seeded (e.g. invite.sent.invitee), else null'),
	locked: z.boolean().describe('True when the rule cannot be changed or removed (409 locked)'),
	lock_reason: z.string().nullable().describe('Why the rule is locked'),
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
