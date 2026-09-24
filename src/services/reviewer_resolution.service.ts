import { Op } from 'sequelize';

import { NotificationChannel } from '../models/index.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('reviewer_resolution');

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
 * Resolve reviewer groups against org-scoped notification channels
 * (shared + personal). Every reviewer target is a channel name.
 */
export async function resolve_reviewer_groups(
    org_id: string,
    groups: ReviewerGroup[],
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

    const channel_map = await _resolve_channel_names(org_id, [...all_targets]);

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
 * Look up org-scoped notification channels by name (shared + personal).
 * Returns a map of target string → channel info.
 */
async function _resolve_channel_names(
    org_id: string,
    targets: string[],
): Promise<Map<string, ResolvedChannel>> {
    if (targets.length === 0) return new Map();

    const channels = await NotificationChannel.findAll({
        where: {
            org_id,
            realm_id: { [Op.is]: null },
            name: { [Op.in]: targets },
            enabled: 1,
        },
        attributes: ['id', 'name', 'user_id'],
    });

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
