import { AbstractChannelDeliverer, type DeliveryContext } from './abstract_channel_deliverer.js';
import type { NotificationPayload } from '../types.js';
import { get_logger } from '../../lib/log.js';
import { InAppNotificationService } from '../../services/in_app_notification.service.js';
import { NotificationChannelRepository } from '../../repositories/notification_channel_repository.js';

const log = get_logger('notify.cliqhub');
const channel_repo = new NotificationChannelRepository();

/**
 * CliqHub in-app channel deliverer — persists a notification row.
 *
 * In-app delivery is a destination type like any other (Slack, email,
 * webhook). Who sees it follows the channel that owns it:
 *   - a personal channel (`user_id`) → that person's inbox;
 *   - a realm channel (`realm_id`) → every member of that realm;
 *   - an org channel → every member of the org (the org "In-app" channel).
 * Realm and org audiences are worked out when people read their inbox, so
 * they follow joins and leaves.
 */
export class CliqHubDeliverer extends AbstractChannelDeliverer {
    readonly provider = 'cliqhub';

    async deliver(
        _config: Record<string, unknown>,
        payload: NotificationPayload,
        context?: DeliveryContext,
    ): Promise<void> {
        const channel = context?.channel_id ? await channel_repo.find_by_id(context.channel_id) : null;
        let row;
        if (channel?.user_id) {
            row = await InAppNotificationService.create_from_payload(payload, channel.user_id);
        } else if (channel?.realm_id) {
            row = await InAppNotificationService.create_from_payload({ ...payload, realm_id: channel.realm_id }, null);
        } else if (channel?.org_id) {
            row = await InAppNotificationService.create_from_payload({ ...payload, realm_id: null }, null, String(channel.org_id));
        } else {
            // No channel context (legacy callers): the event's own realm.
            row = await InAppNotificationService.create_from_payload(payload, null);
        }
        log.info('cliqhub_notification', { id: row.id, event: row.event, audience: channel?.user_id ? 'person' : channel?.realm_id ? 'realm' : channel?.org_id ? 'org' : 'event_realm' });
    }
}
