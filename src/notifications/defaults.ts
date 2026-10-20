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

/** The channels a new org starts with: "In-app" — its in-app goes to every member of the org. */
export const ORG_BUILTIN_CHANNELS: readonly BuiltinChannelSpec[] = [
    {
        system_key: ORG_IN_APP_CHANNEL_KEY,
        name: 'In-app',
        lock_reason: null,
        destinations: [{ type: 'cliqhub', config: {} }],
    },
];

/** Name of a realm's in-app channel to all its members. */
export const REALM_MEMBERS_CHANNEL_NAME = 'All realm members';

/** Id of a realm's "All realm members" channel. */
export function realm_members_channel_id(realm_id: string): string {
    return `cliqhub-${realm_id}`;
}

/** A realm's "All realm members" channel: in-app to every member of the realm. */
export const REALM_MEMBERS_CHANNEL: { name: string; destinations: readonly BuiltinDestination[] } = {
    name: REALM_MEMBERS_CHANNEL_NAME,
    destinations: [{ type: 'cliqhub', config: {} }],
};

/**
 * Events a new realm sends to its "All realm members" channel by default (ordinary rules people
 * can change or remove): a run needing input or stuck, runs that failed or crashed, and review
 * requests.
 */
export const REALM_DEFAULT_RULE_EVENTS = ['phase.input_required', 'phase.idle', 'phase.timed_out', 'run.failed', 'run.crashed', 'hug.review_requested'] as const;

/** `system_key` of a realm's default rule for `event`. */
export function realm_default_rule_key(event: string): string {
    return `realm.members.${event}`;
}
