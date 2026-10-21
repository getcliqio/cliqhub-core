/**
 * What every org and realm starts with in notifications — the one place (PLAN-notifications-v2 A1).
 *
 * - An org: its built-in channels ({@link ORG_BUILTIN_CHANNELS}), seeded by `OrgSeedService.seed_org`.
 * - A realm: its "All realm members" channel ({@link REALM_MEMBERS_CHANNEL}) and the default rules to it
 *   ({@link REALM_DEFAULT_RULE_EVENTS}), seeded by `NotificationService.ensure_realm_members_channel`.
 *
 * Built in = the channel has a `system_key`; locked = its `locked` column (Core answers 409 `locked`).
 * One-time migrations keep their own frozen copies of what they add, so changing a default here never
 * changes what an old migration did.
 */

/** A destination a built-in channel is created with. */
export interface BuiltinDestination {
    type: string;
    config: Record<string, unknown>;
}

/** A channel CliqHub creates itself. */
export interface BuiltinChannelSpec {
    system_key: string;
    name: string;
    /** Set → the channel is locked, and this is shown next to the lock. */
    lock_reason: string | null;
    destinations: readonly BuiltinDestination[];
}

/** `system_key` of the org's in-app channel to all its members. */
export const ORG_IN_APP_CHANNEL_KEY = 'org.in_app';

/** Name of the org's built-in channel to all its members. */
export const ORG_MEMBERS_CHANNEL_NAME = 'All org members';

/**
 * A built-in channel's own destination: one shared in-app notice. Each member is also reached their way — their
 * personal channel's other destinations (email, Slack…) — when it is sent (fan_out `deliver_to_members_their_way`).
 */
const TO_MEMBERS: readonly BuiltinDestination[] = [
    { type: 'cliqhub', config: {} },
];

/** The channels a new org starts with: "All org members" — every member of the org, each the way they chose. */
export const ORG_BUILTIN_CHANNELS: readonly BuiltinChannelSpec[] = [
    {
        system_key: ORG_IN_APP_CHANNEL_KEY,
        name: ORG_MEMBERS_CHANNEL_NAME,
        lock_reason: 'Built in — everyone in the org, each the way they chose.',
        destinations: TO_MEMBERS,
    },
];

/** Name of a realm's in-app channel to all its members. */
export const REALM_MEMBERS_CHANNEL_NAME = 'All realm members';

/** Id of a realm's "All realm members" channel. */
export function realm_members_channel_id(realm_id: string): string {
    return `cliqhub-${realm_id}`;
}

/** `system_key` of a realm's "All realm members" channel. */
export const REALM_MEMBERS_CHANNEL_KEY = 'realm.members';

/** A realm's "All realm members" channel: every member of the realm, each the way they chose. */
export const REALM_MEMBERS_CHANNEL: BuiltinChannelSpec = {
    system_key: REALM_MEMBERS_CHANNEL_KEY,
    name: REALM_MEMBERS_CHANNEL_NAME,
    lock_reason: 'Built in — everyone in the realm, each the way they chose.',
    destinations: TO_MEMBERS,
};

/**
 * Events a new realm sends to its "All realm members" channel by default (ordinary rules people
 * can change or remove): a run stuck, runs that failed or crashed. (A phase that needs a person posts its
 * own Hug to its channels — PLAN-notifications-v2 B4.)
 */
export const REALM_DEFAULT_RULE_EVENTS = ['phase.idle', 'phase.timed_out', 'run.failed', 'run.crashed'] as const;

/** A rule CliqHub fixes: shown with a lock; can't be changed, switched off or removed. */
export interface FixedRuleSpec {
    event: string;
    lock_reason: string;
}

/**
 * Rules every realm has to its "All realm members" channel that nobody can change: a named channel that
 * doesn't exist always reaches the realm.
 */
export const REALM_FIXED_RULES: readonly FixedRuleSpec[] = [
    { event: 'notification.unknown_channel', lock_reason: 'Built in — a channel that doesn’t exist always reaches the realm.' },
];

/** `system_key` of a realm's default rule for `event`. */
export function realm_default_rule_key(event: string): string {
    return `realm.members.${event}`;
}
