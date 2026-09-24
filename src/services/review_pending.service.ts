import { Op } from 'sequelize';

import { RealmMember, Review, ReviewNotification } from '../models/index.js';
import { ApiError } from '../lib/api_error.js';
import {
    load_artifact_counts,
    load_realm_info_map,
    load_run_info_map,
    resolve_team,
} from './review_enrichment.js';

export interface PendingReviewRecord {
    review_id: string;
    realm_id: string;
    realm_name: string | null;
    realm_slug: string | null;
    org_slug: string | null;
    run_id: string | null;
    run_name: string | null;
    phase: string | null;
    team: string | null;
    title: string | null;
    message: string | null;
    review_url: string | null;
    event: string;
    requested_at: number;
    notification_id: string;
    status: string;
    artifact_count: number;
    /** Epoch ms when the review reached a terminal state. */
    resolved_at: number | null;
    /** Epoch ms of the most recent reminder, or null if never reminded. */
    last_reminded_at: number | null;
}

function public_hub_url(): string {
    return (process.env.PUBLIC_APP_URL
        || process.env.CLIQHUB_PUBLIC_URL
        || 'https://cliqhub.io').replace(/\/+$/, '');
}

/**
 * HUG reviews for the authenticated user.
 *
 * Discovery is based on `review_notifications` rows targeting the
 * user — this is the primary mechanism.
 */
export class ReviewPendingService {
    static async list_for_user(opts: {
        user_id: string;
        realm_id?: string;
        /** Org boundary — only show reviews belonging to this org. */
        org_id?: string;
        /** Status values to include. Defaults to ['pending'] (unresolved). */
        statuses?: string[];
        limit?: number;
        offset?: number;
    }): Promise<{ reviews: PendingReviewRecord[]; total: number }> {
        const user_id = opts.user_id.trim();
        if (!user_id) throw ApiError.unauthorized('Authentication required');

        const limit_raw = opts.limit ?? 50;
        const limit = Math.min(Math.max(1, limit_raw), 100);
        const offset = Math.max(0, opts.offset ?? 0);

        const normalized_user_id = String(user_id);

        /**
         * Discover reviews the caller can act on:
         *   1. review_notifications rows targeting user_id (direct assignment).
         *   2. shared-channel rows (user_id IS NULL) on the realm's cliqhub
         *      broadcast channel, when the caller is a realm member.
         *
         * Track review_id → notification_id so the frontend can post a
         * verdict against the correct notification row. Direct assignment
         * wins over broadcast when both exist for the same review.
         */
        const broadcast_channel_ids = await _resolve_broadcast_channel_ids(user_id);

        const notification_rows = await ReviewNotification.findAll({
            where: {
                [Op.or]: [
                    { user_id: normalized_user_id },
                    ...(broadcast_channel_ids.length > 0
                        ? [{
                            user_id: { [Op.is]: null } as any,
                            channel_id: { [Op.in]: broadcast_channel_ids },
                        }]
                        : []),
                ],
            },
            attributes: ['id', 'review_id', 'user_id'],
        });

        /** review_id → notification_id, preferring direct assignment. */
        const notification_id_by_review = new Map<string, string>();
        for (const row of notification_rows) {
            const existing = notification_id_by_review.get(row.review_id);
            if (!existing || row.user_id === normalized_user_id) {
                notification_id_by_review.set(row.review_id, row.id);
            }
        }
        const notified_review_ids = [...notification_id_by_review.keys()];

        if (notified_review_ids.length === 0) return { reviews: [], total: 0 };

        const status_values = opts.statuses?.length
            ? opts.statuses
            : ['pending'];

        const where: Record<string, unknown> = {
            id: { [Op.in]: notified_review_ids },
            status: { [Op.in]: status_values },
        };

        /** Optional realm filter. */
        if (opts.realm_id?.trim()) {
            where.realm_id = opts.realm_id.trim();
        }

        /** Org boundary — restrict to reviews in this org's realms. */
        if (opts.org_id) {
            where.org_id = opts.org_id;
        }

        const total = await Review.count({ where });
        const rows = await Review.findAll({
            where,
            order: [['created_at', 'DESC']],
            limit,
            offset,
        });

        const run_ids = rows.map((r) => r.run_id).filter(Boolean);
        const row_realm_ids = rows.map((r) => r.realm_id).filter((id): id is string => Boolean(id));
        const [run_info, realm_info, artifact_counts] = await Promise.all([
            load_run_info_map(run_ids),
            load_realm_info_map(row_realm_ids),
            load_artifact_counts(run_ids),
        ]);

        const hub = public_hub_url();
        const reviews = rows.map((row) => {
            const phase = typeof row.payload.phase === 'string' ? row.payload.phase : null;
            const run = row.run_id ? run_info.get(row.run_id) : undefined;
            const realm = row.realm_id ? realm_info.get(row.realm_id) : undefined;
            const payload_message = typeof row.payload.message === 'string' ? row.payload.message.trim() : '';
            const upstream_text = typeof row.payload.upstream_text === 'string'
                ? row.payload.upstream_text.trim()
                : '';
            const brief = payload_message
                || (upstream_text ? upstream_text.slice(0, 240) : '')
                || (row.status === 'pending' ? 'Awaiting human verdict' : 'Verdict submitted — awaiting ack');
            const title = typeof row.payload.title === 'string' && row.payload.title.trim()
                ? row.payload.title.trim()
                : (phase ? `Review: ${phase}` : 'Human review');

            return {
                review_id: row.id,
                realm_id: row.realm_id ?? '',
                realm_name: realm?.realm_name ?? null,
                realm_slug: realm?.realm_slug ?? null,
                org_slug: realm?.org_slug ?? null,
                run_id: row.run_id,
                run_name: run?.run_name ?? null,
                phase,
                team: resolve_team(row.payload, run),
                title,
                message: brief,
                review_url: `${hub}/reviews/${row.id}`,
                event: row.status === 'pending' ? 'hug.review_requested' : 'hug.review_responded',
                requested_at: row.created_at.getTime(),
                notification_id: notification_id_by_review.get(row.id) ?? row.id,
                status: row.status,
                artifact_count: row.run_id ? (artifact_counts.get(row.run_id) ?? 0) : 0,
                resolved_at: row.completed_at ? row.completed_at.getTime() : null,
                last_reminded_at: row.last_reminded_at ? row.last_reminded_at.getTime() : null,
            };
        });

        return { reviews, total };
    }

    /**
     * Count-only variant of list_for_user — returns the number of
     * pending reviews the caller can act on. Used by the sidebar badge
     * so the count always matches the HUG table.
     */
    static async count_pending_for_user(opts: {
        user_id: string;
        org_id?: string;
    }): Promise<number> {
        const user_id = opts.user_id.trim();
        if (!user_id) return 0;

        const normalized_user_id = String(user_id);
        const broadcast_channel_ids = await _resolve_broadcast_channel_ids(user_id);

        const notification_rows = await ReviewNotification.findAll({
            where: {
                [Op.or]: [
                    { user_id: normalized_user_id },
                    ...(broadcast_channel_ids.length > 0
                        ? [{
                            user_id: { [Op.is]: null } as any,
                            channel_id: { [Op.in]: broadcast_channel_ids },
                        }]
                        : []),
                ],
            },
            attributes: ['review_id'],
        });

        const review_ids = [...new Set(notification_rows.map((r) => r.review_id))];
        if (review_ids.length === 0) return 0;

        const where: Record<string, unknown> = {
            id: { [Op.in]: review_ids },
            status: 'pending',
        };
        if (opts.org_id) {
            where.org_id = opts.org_id;
        }

        return Review.count({ where });
    }
}

/**
 * Build the list of `cliqhub-<realm_id>` broadcast channel IDs for
 * every realm this user belongs to. Used to include realm-wide HUG
 * reviews (those with no explicit reviewers) in a user's pending list.
 */
async function _resolve_broadcast_channel_ids(user_id: string): Promise<string[]> {
    const memberships = await RealmMember.findAll({
        where: { member_type: 'user', member_id: user_id },
        attributes: ['realm_id'],
    });
    return memberships.map((m) => `cliqhub-${m.realm_id}`);
}
