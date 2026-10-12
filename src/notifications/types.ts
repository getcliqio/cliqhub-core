/**
 * Shared notification domain types — channel providers, event groups, DTOs.
 */

import { EVENT_TYPES, type EventType, is_event_type } from '../schemas/event_types.js';

export const CHANNEL_PROVIDERS = ['slack', 'email', 'webhook', 'cliqhub'] as const;
export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number];

const PROVIDER_SET: ReadonlySet<string> = new Set(CHANNEL_PROVIDERS);

export function is_channel_provider(value: string): value is ChannelProvider {
	return PROVIDER_SET.has(value);
}

export const EVENT_GROUPS = [
	'run.*',
	'phase.*',
	'hug.*',
	'team.*',
	'daemon.*',
	'realm.*',
	'auth.*',
	'notification.*',
	'invite.*',
	'org.*',
	'user.*',
] as const;

export type EventGroup = (typeof EVENT_GROUPS)[number];

/** Aliases without `.*` accepted on bind (stored normalized with `.*`). */
export const EVENT_GROUP_ALIASES: Record<string, EventGroup> = {
	run: 'run.*',
	phase: 'phase.*',
	hug: 'hug.*',
	team: 'team.*',
	daemon: 'daemon.*',
	realm: 'realm.*',
	auth: 'auth.*',
	notification: 'notification.*',
	invite: 'invite.*',
	org: 'org.*',
	user: 'user.*',
};

function types_with_prefix(prefix: string): readonly EventType[] {
	return EVENT_TYPES.filter((t) => t.startsWith(prefix));
}

export const EVENT_GROUP_TYPES: Record<EventGroup, readonly EventType[]> = {
	'run.*': types_with_prefix('run.'),
	'phase.*': types_with_prefix('phase.'),
	'hug.*': types_with_prefix('hug.'),
	'team.*': types_with_prefix('team.'),
	'daemon.*': types_with_prefix('daemon.'),
	'realm.*': types_with_prefix('realm.'),
	'auth.*': types_with_prefix('auth.'),
	'notification.*': types_with_prefix('notification.'),
	'invite.*': types_with_prefix('invite.'),
	'org.*': types_with_prefix('org.'),
	'user.*': types_with_prefix('user.'),
};

const GROUP_SET: ReadonlySet<string> = new Set(EVENT_GROUPS);

export function is_event_group(value: string): value is EventGroup {
	return GROUP_SET.has(value);
}

/** Normalize alias → group, or return group/type as-is. */
export function normalize_event_selector(raw: string): string {
	const trimmed = raw.trim();
	const alias = EVENT_GROUP_ALIASES[trimmed];
	if (alias) return alias;
	return trimmed;
}

export function expand_event_selector(selector: string): EventType[] {
	const normalized = normalize_event_selector(selector);
	if (is_event_group(normalized)) {
		return [...EVENT_GROUP_TYPES[normalized]];
	}
	if (is_event_type(normalized)) {
		return [normalized];
	}
	return [];
}

/** True if selector is a concrete EventType, EventGroup, or custom.* (after alias normalize). */
export function is_valid_event_selector(selector: string): boolean {
	const normalized = normalize_event_selector(selector);
	return is_event_type(normalized) || is_event_group(normalized);
}

/** Selectors stored on a subscription that match a concrete event type. */
export function selectors_matching_event(type: EventType): string[] {
	const selectors: string[] = [type];
	for (const group of EVENT_GROUPS) {
		if (EVENT_GROUP_TYPES[group].includes(type)) {
			selectors.push(group);
		}
	}
	return selectors;
}

export type NotificationDispatchStatus = 'dispatched' | 'skipped' | 'failed' | 'deferred';

export interface ChannelDto {
	id: string;
	realm_id: string;
	name: string;
	provider: ChannelProvider;
	config: Record<string, unknown>;
	/** v2: multi-destination array. */
	destinations: unknown[];
	enabled: boolean;
	created_at: number;
	updated_at: number;
}

export interface SubscriptionDto {
	id: string;
	realm_id: string;
	channel_id: string;
	event: string;
	scope: string;
	created_at: number;
}

export interface NotificationPayload {
	event: string;
	title?: string;
	message?: string;
	realm_id?: string | null;
	team_slug?: string | null;
	run_id?: string | null;
	phase_name?: string | null;
	severity?: string | null;
	reason?: string | null;
	outcome?: string | null;
	run_name?: string | null;
	daemon_name?: string | null;
	daemon_id?: string | null;
	[key: string]: unknown;
}

/** Readable names for event types people see as notification titles (the rest are worded from the type). */
const EVENT_TITLES: Record<string, string> = {
	'phase.input_required': 'Input needed',
	'phase.inputs_supplied': 'Input supplied',
	'phase.idle': 'Phase idle',
	'phase.timed_out': 'Phase timed out',
	'hug.review_requested': 'Review requested',
	'hug.review_reminded': 'Review reminder',
	'hug.review_resolved': 'Review resolved',
	'hug.review_responded': 'Review answered',
	'hug.review_expired': 'Review expired',
	'hug.routing_requested': 'Routing requested',
};

/**
 * A readable title for an event type: "run.failed" → "Run failed", "phase.timed_out" →
 * "Phase timed out", with a few names set in {@link EVENT_TITLES}.
 */
export function event_title(type: string): string {
	const known = EVENT_TITLES[type];
	if (known) return known;
	const words = type.replace(/[._]+/g, ' ').trim();
	return words ? words[0].toUpperCase() + words.slice(1) : type;
}
