/**
 * Yamazaki notify intent for Hub fan-out (H3.3).
 *
 * Daemon may attach `{ notify: { channels: false | string[] } }` on the
 * event payload. Absent notify key or `[]` → the realm's rules. Explicit
 * `false` mutes. (The realm's defaults are ordinary rules on its "All realm
 * members" channel, not a hidden all-users fallback.)
 *
 * @see design/yamazaki/DEFAULTS.md
 */

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
	| { action: 'refs'; refs: string[] }
	| { action: 'rules' };

/** Decide fan-out plan before DB channel resolution: mute, explicit refs (non-empty), else rules. */
export function plan_fan_out(intent: NotifyChannelsIntent): FanOutPlan {
	if (intent === false) return { action: 'mute' };
	if (Array.isArray(intent) && intent.length > 0) {
		return { action: 'refs', refs: intent };
	}
	return { action: 'rules' };
}
