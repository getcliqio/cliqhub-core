import { AbstractChannelDeliverer, type DeliveryContext } from './abstract_channel_deliverer.js';
import type { NotificationPayload } from '../types.js';
import { get_logger } from '../../lib/log.js';
import { InAppNotificationService } from '../../services/in_app_notification.service.js';
import { NotificationChannel } from '../../models/index.js';

const log = get_logger('notify.cliqhub');

/**
 * CliqHub in-app channel deliverer — persists a notification row.
 *
 * In-app delivery is a destination type like any other (Slack, email,
 * webhook). When the owning channel has a `user_id`, the resulting
 * in_app_notification row gets `user_id` set so it appears in that
 * user's inbox. Otherwise the notification is broadcast (realm-scoped).
 */
export class CliqHubDeliverer extends AbstractChannelDeliverer {
    readonly provider = 'cliqhub';

    async deliver(
        _config: Record<string, unknown>,
        payload: NotificationPayload,
        context?: DeliveryContext,
    ): Promise<void> {
        /** Read user_id from the channel row for targeted inbox delivery. */
        let target_user_id: string | null = null;
        const channel_id = context?.channel_id;
        if (channel_id) {
            const channel = await NotificationChannel.findByPk(channel_id, {
                attributes: ['user_id'],
            });
            if (channel?.user_id) {
                target_user_id = channel.user_id;
            }
        }

        const row = await InAppNotificationService.create_from_payload(
            payload, target_user_id,
        );
        log.info(`cliqhub notification id=${row.id} event=${row.event} user_id=${target_user_id ?? 'broadcast'}`);
    }
}
