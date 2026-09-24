import { randomUUID } from 'node:crypto';

import { NotificationChannel, ChannelDestination } from '../models/index.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('per_user_channel');

/**
 * Ensure a per-user in-app notification channel exists for the given
 * user + org combination. Idempotent — creates if missing.
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
    const [channel, created] = await NotificationChannel.findOrCreate({
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
        /** Write the default in-app destination row. */
        await ChannelDestination.findOrCreate({
            where: { channel_id: channel.id, type: 'cliqhub' },
            defaults: {
                id: randomUUID(),
                channel_id: channel.id,
                type: 'cliqhub',
                config: {},
                created_at: now,
            },
        });

        log.info('per_user_channel_created', { user_id, org_id, username, channel_id: channel.id });
    }

    return channel.id;
}
