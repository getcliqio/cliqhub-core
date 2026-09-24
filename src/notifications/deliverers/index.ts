import { ApiError } from '../../lib/api_error.js';
import {
	CHANNEL_PROVIDERS,
	is_channel_provider,
	type ChannelProvider,
} from '../types.js';
import { AbstractChannelDeliverer } from './abstract_channel_deliverer.js';
import { SlackDeliverer } from './slack_deliverer.js';
import { EmailDeliverer } from './email_deliverer.js';
import { WebhookDeliverer } from './webhook_deliverer.js';
import { CliqHubDeliverer } from './cliqhub_deliverer.js';

export { AbstractChannelDeliverer } from './abstract_channel_deliverer.js';

export const DELIVERER_BY_PROVIDER: Record<ChannelProvider, AbstractChannelDeliverer> = {
	slack: new SlackDeliverer(),
	email: new EmailDeliverer(),
	webhook: new WebhookDeliverer(),
	cliqhub: new CliqHubDeliverer(),
};

export function get_deliverer(provider: string): AbstractChannelDeliverer {
	if (!is_channel_provider(provider)) {
		throw ApiError.bad_request(
			`Unknown notification provider '${provider}'. `
			+ `Must be one of: ${CHANNEL_PROVIDERS.join(', ')}`,
		);
	}
	return DELIVERER_BY_PROVIDER[provider];
}
