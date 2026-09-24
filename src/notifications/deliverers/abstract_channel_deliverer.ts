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
}

export abstract class AbstractChannelDeliverer {
	abstract readonly provider: string;

	abstract deliver(
		config: Record<string, unknown>,
		payload: NotificationPayload,
		context?: DeliveryContext,
	): Promise<void>;
}
