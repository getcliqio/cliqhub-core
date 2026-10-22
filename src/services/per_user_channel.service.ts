import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';

import { NotificationChannelRepository } from '../repositories/notification_channel_repository.js';
import { ChannelDestinationRepository } from '../repositories/channel_destination_repository.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('per_user_channel');
const channel_repo = new NotificationChannelRepository();
const destination_repo = new ChannelDestinationRepository();

/**
 * Destinations a new personal channel starts with: in-app, and email to the
 * account's current address (`account: true` is resolved when sending).
 * In-app always stays (the owner can't remove it).
 */
export const PERSONAL_CHANNEL_DESTINATIONS: ReadonlyArray<{ type: string; config: Record<string, unknown> }> = [
    { type: 'cliqhub', config: {} },
    { type: 'email', config: { account: true } },
];

/**
 * A person's personal channel — "how to reach me". One per user for the whole account (no org, no realm),
 * named after the username. Idempotent: creates it when missing, with {@link PERSONAL_CHANNEL_DESTINATIONS};
 * an existing one is left as it is. Returns the channel id.
 */
export async function ensure_personal_channel(user_id: string, username: string): Promise<string> {
    const now = Date.now();
    const [channel, created] = await channel_repo.find_or_create({
        where: { user_id },
        defaults: {
            id: randomUUID(),
            realm_id: null,
            org_id: null,
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
        log.info('personal_channel_created', { user_id, username, channel_id: channel.id });
    }
    return channel.id;
}

/**
 * The personal channel of the user named `name` — how a name like "elan" reaches Elan. From a realm, Elan must
 * be a member of that realm; otherwise an active member of `org_id`. Null when there's no such member.
 */
export async function find_member_personal_channel(
    name: string,
    where: { org_id: string | null; realm_id?: string | null },
): Promise<{ id: string; user_id: string } | null> {
    const username = name.trim().replace(/^@/, '');
    if (!username || (!where.org_id && !where.realm_id)) return null;
    const { User, OrgMember, RealmMember, NotificationChannel } = await import('../models/index.js');
    const user = await User.findOne({ where: { username: { [Op.iLike]: username }, deleted_at: null } as never, attributes: ['id'], raw: true }) as { id: string } | null;
    if (!user) return null;
    const member = where.realm_id
        ? await RealmMember.findOne({ where: { realm_id: where.realm_id, member_type: 'user', member_id: String(user.id) } as never, attributes: ['id'], raw: true })
        : await OrgMember.findOne({ where: { org_id: where.org_id, user_id: String(user.id), status: 'active' } as never, attributes: ['user_id'], raw: true });
    if (!member) return null;
    const channel = await NotificationChannel.findOne({ where: { user_id: String(user.id), enabled: 1 } as never, attributes: ['id', 'user_id'], raw: true }) as { id: string; user_id: string } | null;
    return channel ? { id: String(channel.id), user_id: String(channel.user_id) } : null;
}
