/**
 * Notifications API — Zod request schemas (SoT for inbound bodies).
 * Every field must have `.describe(…)` (feeds Hub OpenAPI / Mintlify).
 */

import { z } from 'zod';

import { destination_schema } from '../../notifications/channel_config.js';

/** POST /v1/notification_channels/get */
export const NotificationChannelsGetInput = z.object({
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
});
export type NotificationChannelsGetInput = z.infer<typeof NotificationChannelsGetInput>;

/** POST /v1/notification_channels/create */
export const NotificationChannelsCreateInput = z.object({
    realm_id: z.string().min(1).optional().describe('When set, create a realm channel; omit for an org/account channel'),
    name: z.string().describe('Unique channel name within the realm or org scope'),
    destinations: z.array(destination_schema).min(1).describe('One or more delivery destinations (slack, email, webhook, cliqhub, channel_ref, …)'),
    enabled: z.boolean().optional().describe('When false, channel is created disabled (default enabled)'),
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
    realm_id: z.string().min(1).optional().describe('When set, list realm (and optional team) rules; omit for org-global rules'),
    team_slug: z.string().min(1).optional().describe('When set with realm_id, filter to team-scoped rules'),
    effective: z.boolean().optional().describe('When true with realm_id, merge org + realm tiers for what actually fires'),
});
export type NotificationRulesListInput = z.infer<typeof NotificationRulesListInput>;

/** POST /v1/orgs|realms/set_notification_rule */
export const NotificationRulesSetInput = z.object({
    realm_id: z.string().min(1).optional().describe('When set, upsert a realm/team rule; omit for org-global'),
    team_slug: z.string().min(1).optional().describe('Optional team scope under the realm'),
    event: z.string().min(1).describe('Event selector (exact type, family wildcard like run.*, or *)'),
    channel_id: z.string().min(1).describe('Target notification channel id'),
    priority: z.number().int().optional().describe('Rule priority (higher wins within a tier when supported)'),
});
export type NotificationRulesSetInput = z.infer<typeof NotificationRulesSetInput>;

/** POST /v1/orgs|realms/remove_notification_rule */
export const NotificationRulesRemoveInput = z.object({
    id: z.string().uuid().describe('Rule UUID to delete'),
});
export type NotificationRulesRemoveInput = z.infer<typeof NotificationRulesRemoveInput>;

/** POST /v1/notifications/get */
export const NotificationsGetInput = z.object({
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
}).optional();
export type NotificationsGetInput = z.infer<typeof NotificationsGetInput>;
