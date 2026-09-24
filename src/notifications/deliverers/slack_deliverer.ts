import { AbstractChannelDeliverer } from './abstract_channel_deliverer.js';
import type { NotificationPayload } from '../types.js';
import { get_logger } from '../../lib/log.js';

const log = get_logger('notify.slack');

export class SlackDeliverer extends AbstractChannelDeliverer {
	readonly provider = 'slack';

	async deliver(
		config: Record<string, unknown>,
		payload: NotificationPayload,
	): Promise<void> {
		const webhook_url = config.webhook_url;
		if (typeof webhook_url !== 'string' || !webhook_url) {
			log.warn('Slack channel missing webhook_url');
			return;
		}

		const text = format_slack(payload);
		const res = await fetch(webhook_url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text }),
		});

		if (!res.ok) {
			log.warn(`Slack webhook returned ${res.status}`);
		}
	}
}

function format_slack(p: NotificationPayload): string {
	if (typeof p.message === 'string' && p.message.trim()) return p.message;
	const tag = [p.team_slug, p.run_id?.toString().slice(0, 8)].filter(Boolean).join(' | ');
	const title = p.title ?? p.event;
	return `*${title}* (${tag || 'cliq'})\n${p.message ?? ''}`.trim();
}
