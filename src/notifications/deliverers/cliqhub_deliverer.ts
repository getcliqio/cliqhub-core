import { AbstractChannelDeliverer, type DeliveryContext, type EventSends } from './abstract_channel_deliverer.js';
import type { NotificationPayload } from '../types.js';
import { get_logger } from '../../lib/log.js';
import { InAppNotificationService } from '../../services/in_app_notification.service.js';
import { NotificationChannelRepository } from '../../repositories/notification_channel_repository.js';

const log = get_logger('notify.cliqhub');
const channel_repo = new NotificationChannelRepository();

/** Whether this event's shared realm / org notice already reaches the person (they're a member). */
async function covered_by_shared(user_id: string, sends: EventSends): Promise<boolean> {
    const { RealmMember, OrgMember } = await import('../../models/index.js');
    if (sends.inbox_realms.size > 0 && await RealmMember.findOne({ where: { realm_id: [...sends.inbox_realms], member_type: 'user', member_id: user_id } as never, attributes: ['id'], raw: true })) return true;
    if (sends.inbox_orgs.size > 0 && await OrgMember.findOne({ where: { org_id: [...sends.inbox_orgs], user_id, status: 'active' } as never, attributes: ['user_id'], raw: true })) return true;
    return false;
}

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
        const sends = context?.sends;
        // Once per event: one notice per audience; a person already covered by this event's shared realm/org
        // notice gets no personal copy.
        if (sends) {
            if (channel?.user_id) {
                if (!sends.take(`inbox|user|${channel.user_id}`) || await covered_by_shared(String(channel.user_id), sends)) return;
            } else if (channel?.realm_id) {
                if (!sends.take(`inbox|realm|${channel.realm_id}`)) return;
                sends.inbox_realms.add(String(channel.realm_id));
            } else if (channel?.org_id) {
                if (!sends.take(`inbox|org|${channel.org_id}`)) return;
                sends.inbox_orgs.add(String(channel.org_id));
            }
        }
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
