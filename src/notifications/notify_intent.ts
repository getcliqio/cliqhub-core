/**
 * Yamazaki notify intent for Hub fan-out (H3.3).
 *
 * Daemon may attach `{ notify: { channels: false | string[] } }` on the
 * event payload. Absent notify key ≡ omit. `[]` ≡ absent for default-notify
 * → all-users. Explicit `false` mutes. Never invent all-users in the daemon.
 *
 * @see design/yamazaki/DEFAULTS.md
 */

export const DEFAULT_NOTIFY_EVENTS = [
	'phase.input_required',
	'phase.idle',
	'phase.timed_out',
	'run.failed',
	'run.crashed',
] as const;

export type DefaultNotifyEvent = (typeof DEFAULT_NOTIFY_EVENTS)[number];

const DEFAULT_NOTIFY_SET: ReadonlySet<string> = new Set(DEFAULT_NOTIFY_EVENTS);

export function is_default_notify_event(type: string): boolean {
	return DEFAULT_NOTIFY_SET.has(type);
}

export type NotifyChannelsIntent = false | string[] | undefined;

/**
 * Extract notify intent from submitted event payload.
 * - `undefined` — key absent
 * - `false` — mute
 * - `string[]` — refs (may be empty)
 */
export function read_notify_channels_intent(
	payload: Record<string, unknown> | null | undefined,
): NotifyChannelsIntent {
	if (!payload || typeof payload !== 'object') return undefined;
	const notify = payload.notify;
	if (notify === undefined || notify === null) return undefined;
	if (typeof notify !== 'object' || Array.isArray(notify)) return undefined;
	const channels = (notify as { channels?: unknown }).channels;
	if (channels === false) return false;
	if (Array.isArray(channels)) {
		return channels.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
	}
	return undefined;
}

export type FanOutPlan =
	| { action: 'mute' }
	| { action: 'all_users' }
	| { action: 'refs'; refs: string[] }
	| { action: 'rules' };

/**
 * Decide fan-out plan before DB channel resolution.
 * Explicit refs (non-empty) win. Empty `[]` and absent share all_users
 * only for default-notify events; otherwise fall through to rules.
 */
export function plan_fan_out(
	event_type: string,
	intent: NotifyChannelsIntent,
): FanOutPlan {
	if (intent === false) return { action: 'mute' };
	if (Array.isArray(intent) && intent.length > 0) {
		return { action: 'refs', refs: intent };
	}
	// absent or []
	if (is_default_notify_event(event_type)) {
		return { action: 'all_users' };
	}
	return { action: 'rules' };
}
