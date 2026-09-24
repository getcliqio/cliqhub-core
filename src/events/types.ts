/**
 * Closed catalog of Hub event types (`{domain}.{verb}`).
 * Submit rejects any string not in this list.
 * Notifications (channel delivery) are a side effect of accepted events — later.
 */

export const EVENT_TYPES = [
	'run.started',
	'run.resumed',
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
};
