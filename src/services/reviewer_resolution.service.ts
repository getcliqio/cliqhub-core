import { Op } from 'sequelize';

import { NotificationChannelRepository } from '../repositories/notification_channel_repository.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('reviewer_resolution');
const channel_repo = new NotificationChannelRepository();

/**
 * A single reviewer group as declared in the team YAML or supplied at
 * dispatch/review creation time.
 */
export interface ReviewerGroup {
    policy: 'any' | 'all';
    channels: string[];
}

/**
 * A resolved destination — the product of matching a reviewer string
 * against org members and notification channels.
 */
export interface ResolvedDestination {
    /** Original string from the YAML / request. */
    target: string;
    /** Resolved user ID if the target matched an org member username. */
    user_id: string | null;
    /** Per-user notification channel ID (user-{uid}-org-{oid}) if user matched. */
    channel_id: string | null;
    /** Non-user notification channel ID if the target matched a channel name. */
    named_channel_id: string | null;
}

/**
 * A fully resolved reviewer group ready for persistence.
 */
export interface ResolvedGroup {
    policy: 'any' | 'all';
    destinations: ResolvedDestination[];
}

/**
 * Resolve reviewer groups against the channels the realm can use: the realm's own and its org's
 * (shared + personal). Every reviewer target is a channel name.
 */
export async function resolve_reviewer_groups(
    org_id: string,
    groups: ReviewerGroup[],
    realm_id?: string | null,
): Promise<ResolvedGroup[]> {
    /** Collect all unique target strings across groups. */
    const all_targets = new Set<string>();
    for (const group of groups) {
        for (const ch of group.channels) {
            const trimmed = ch.trim();
            if (trimmed) all_targets.add(trimmed);
        }
    }

    if (all_targets.size === 0) {
        return groups.map((g) => ({ policy: g.policy, destinations: [] }));
    }

    const channel_map = await _resolve_channel_names(org_id, [...all_targets], realm_id ?? null);

    /** Build resolved groups. */
    const resolved: ResolvedGroup[] = [];
    for (const group of groups) {
        const destinations: ResolvedDestination[] = [];

        for (const ch of group.channels) {
            const target = ch.trim();
            if (!target) continue;

            const channel = channel_map.get(target);
            if (!channel) {
                log.warn('reviewer_unresolved', { target, org_id });
                continue;
            }

            destinations.push({
                target,
                user_id: channel.user_id,
                channel_id: channel.user_id ? channel.id : null,
                named_channel_id: channel.user_id ? null : channel.id,
            });
        }

        resolved.push({ policy: group.policy, destinations });
    }

    return resolved;
}


// ── Internal helpers ─────────────────────────────────────────────

interface ResolvedChannel {
    id: string;
    user_id: string | null;
}

/**
 * Look up enabled channels by name: the realm's own (when given) and the org's (shared + personal).
 * A realm channel wins over an org channel of the same name.
 * Returns a map of target string → channel info.
 */
async function _resolve_channel_names(
    org_id: string,
    targets: string[],
    realm_id: string | null,
): Promise<Map<string, ResolvedChannel>> {
    if (targets.length === 0) return new Map();

    const scopes: Record<string, unknown>[] = [{ org_id, realm_id: { [Op.is]: null } }];
    if (realm_id) scopes.push({ realm_id });
    const channels = await channel_repo.find_all(
        {
            [Op.or]: scopes,
            name: { [Op.in]: targets },
            enabled: 1,
        } as any,
        { attributes: ['id', 'name', 'user_id', 'realm_id'] },
    );
    /** Org channels first, so a realm channel of the same name replaces it. */
    channels.sort((a, b) => Number(Boolean(a.realm_id)) - Number(Boolean(b.realm_id)));

    const result = new Map<string, ResolvedChannel>();
    for (const ch of channels) {
        const original = targets.find(
            (t) => t.toLowerCase() === ch.name.toLowerCase(),
        );
        if (original) {
            result.set(original, { id: ch.id, user_id: ch.user_id ?? null });
        }
    }

    return result;
}
