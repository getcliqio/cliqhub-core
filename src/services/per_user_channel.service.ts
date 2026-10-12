import { randomUUID } from 'node:crypto';

import { NotificationChannelRepository } from '../repositories/notification_channel_repository.js';
import { ChannelDestinationRepository } from '../repositories/channel_destination_repository.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('per_user_channel');
const channel_repo = new NotificationChannelRepository();
const destination_repo = new ChannelDestinationRepository();

/**
 * Destinations a new personal channel starts with: in-app, and email to the
 * account's current address (`account: true` is resolved when sending).
 */
export const PERSONAL_CHANNEL_DESTINATIONS: ReadonlyArray<{ type: string; config: Record<string, unknown> }> = [
    { type: 'cliqhub', config: {} },
    { type: 'email', config: { account: true } },
];

/**
 * Ensure a person's personal channel exists for the given user + org
 * combination. Idempotent — creates if missing, with in-app and email
 * ({@link PERSONAL_CHANNEL_DESTINATIONS}); an existing channel is left as it is.
 *
 * Uses `(user_id, org_id)` unique index for lookup. Channel ID is a
 * standard UUID. Returns the channel ID.
 */
export async function ensure_per_user_channel(
    user_id: string,
    org_id: string,
    username: string,
): Promise<string> {
    const now = Date.now();

    /** Look up by the proper columns, not a mangled ID. */
    const [channel, created] = await channel_repo.find_or_create({
        where: { user_id, org_id },
        defaults: {
            id: randomUUID(),
            realm_id: null,
            org_id,
            user_id,
            name: username,
            enabled: 1,
            created_at: now,
            updated_at: now,
        } as any,
    });

    if (created) {
        for (const dest of PERSONAL_CHANNEL_DESTINATIONS) {
            await destination_repo.find_or_create({
                where: { channel_id: channel.id, type: dest.type },
                defaults: {
                    id: randomUUID(),
                    channel_id: channel.id,
                    type: dest.type,
                    config: dest.config,
                    created_at: now,
                },
            });
        }

        log.info('per_user_channel_created', { user_id, org_id, username, channel_id: channel.id });
    }

    return channel.id;
}
