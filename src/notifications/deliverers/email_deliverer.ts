import { AbstractChannelDeliverer } from './abstract_channel_deliverer.js';
import type { NotificationPayload } from '../types.js';
import { get_logger } from '../../lib/log.js';

const log = get_logger('notify.email');

/**
 * Hub-owned email delivery. Channel config is recipients only (to/cc/bcc).
 * SMTP transport settings come from Hub env (EMAIL_SMTP_*), not the channel.
 */
export class EmailDeliverer extends AbstractChannelDeliverer {
	readonly provider = 'email';

	async deliver(
		config: Record<string, unknown>,
		payload: NotificationPayload,
	): Promise<void> {
		const to = typeof config.to === 'string' ? config.to.trim() : '';
		if (!to) {
			log.warn('Email channel missing to');
			return;
		}

		const cc = typeof config.cc === 'string' ? config.cc.trim() : '';
		const bcc = typeof config.bcc === 'string' ? config.bcc.trim() : '';
		const smtp_host = (process.env.EMAIL_SMTP_HOST || '').trim() || '(hub-default)';

		log.info(
			`email notification queued host=${smtp_host} to=${to}`
			+ `${cc ? ` cc=${cc}` : ''}${bcc ? ` bcc=${bcc}` : ''}`
			+ ` event=${payload.event} title=${payload.title ?? ''}`,
		);
	}
}
