import type { NotificationPayload } from '../types.js';

/**
 * Cross-cutting delivery context supplied by fan_out. Kept optional so
 * v2 destination_to_config paths (which have no owning channel row)
 * can call deliver without it. Individual deliverers use whatever
 * fields make sense — WebhookDeliverer reads `channel_id` for the
 * audit table (JIRA slice 1.4); other providers ignore it.
 */
export interface DeliveryContext {
	/** Owning notification_channel row, if the destination came from one. */
	channel_id?: string;
	/** What one event already sent — so the same endpoint gets it once (absent: no de-duplication). */
	sends?: EventSends;
}

/**
 * Everything one event has sent so far, across all its channels: each final endpoint — an email address, a
 * Slack or webhook URL, an inbox — gets the event once. A shared realm/org in-app notice covers its members, so
 * they get no personal in-app copy in the same event.
 */
export class EventSends {
	private readonly _keys = new Set<string>();
	/** Realms / orgs whose shared in-app notice this event wrote. */
	readonly inbox_realms = new Set<string>();
	readonly inbox_orgs = new Set<string>();

	/** True the first time `key` is seen (send it); false after (skip it). */
	take(key: string): boolean {
		if (this._keys.has(key)) return false;
		this._keys.add(key);
		return true;
	}

	/** The event type (for the person layer: who switched it off for themselves). */
	event = '';
	private readonly _off = new Map<string, boolean>();

	/** Whether this person switched this event off for themselves (PLAN-notification-layers D). Cached per event. */
	async person_off(user_id: string): Promise<boolean> {
		const hit = this._off.get(user_id);
		if (hit !== undefined) return hit;
		const { PersonSettingsService } = await import('../../services/person_settings.service.js');
		const off = this.event ? (await PersonSettingsService.off_for([user_id], this.event)).has(user_id) : false;
		this._off.set(user_id, off);
		return off;
	}
}

export abstract class AbstractChannelDeliverer {
	abstract readonly provider: string;

	abstract deliver(
		config: Record<string, unknown>,
		payload: NotificationPayload,
		context?: DeliveryContext,
	): Promise<void>;
}
