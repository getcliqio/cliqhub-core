/**
 * What every org and realm starts with in notifications — the one place (PLAN-notifications-v2 A1).
 *
 * - An org: its built-in channels ({@link ORG_BUILTIN_CHANNELS}), seeded by `OrgSeedService.seed_org`.
 * - An org also gets its default rules ({@link ORG_DEFAULT_RULES}).
 * - A realm: its "All realm members" channel ({@link REALM_MEMBERS_CHANNEL}), no rules, made by
 *   `NotificationService.ensure_realm_members_channel`.
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

/**
 * The channels a new org starts with: "All org members" — every member of the org — and "All realm members" —
 * everyone in the realm an event comes from (the org's default rule uses it); each the way they chose.
 */
export const ORG_BUILTIN_CHANNELS: readonly BuiltinChannelSpec[] = [
    {
        system_key: ORG_IN_APP_CHANNEL_KEY,
        name: ORG_MEMBERS_CHANNEL_NAME,
        lock_reason: 'Built in — everyone in the org, each the way they chose.',
        destinations: TO_MEMBERS,
    },
    {
        system_key: 'org.realm_members',
        name: 'All realm members',
        lock_reason: 'Built in — everyone in the realm the event comes from, each the way they chose.',
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

/** `system_key` of an org's "All realm members" channel: whichever realm the event comes from. */
export const ORG_REALM_MEMBERS_CHANNEL_KEY = 'org.realm_members';

/** A rule CliqHub gives every org (an ordinary rule: the org can change, switch off or remove it). */
export interface OrgDefaultRuleSpec {
    system_key: string;
    event: string;
    /** `system_key` of the org's built-in channel it goes to. */
    channel_key: string;
    /** The org defaults version that introduced it (OrgSeedService.DEFAULTS_VERSION). */
    version: number;
}

/**
 * What every org sends by default — one rule, set on the org so it applies in every realm: a failed run
 * reaches everyone in that run's realm, each the way they chose. Nothing else is sent by default
 * (decided 2026-10-22).
 */
export const ORG_DEFAULT_RULES: readonly OrgDefaultRuleSpec[] = [
    { system_key: 'org.default.run.failed', event: 'run.failed', channel_key: ORG_REALM_MEMBERS_CHANNEL_KEY, version: 4 },
];
