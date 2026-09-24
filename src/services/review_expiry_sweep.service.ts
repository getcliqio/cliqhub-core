import { QueryTypes } from 'sequelize';

import { get_sequelize } from '../db/sequelize.js';
import { EventSubmitService } from '../events/index.js';
import { ReviewNotification } from '../models/review_notification.model.js';
import { HugReviewsService } from './hug_reviews.service.js';

const SWEEP_INTERVAL_MS = parseInt(
    process.env.REVIEW_EXPIRY_SWEEP_MS ?? '60000', 10,
);

let _timer: ReturnType<typeof setInterval> | null = null;

interface ExpiredRow {
    id: string;
    run_id: string;
    daemon_id: string | null;
    realm_id: string | null;
}

interface RemindRow {
    id: string;
}

/**
 * Periodic sweep that expires reviews whose timeout has passed.
 *
 * Moves `status` from `pending` → `expired` and emits
 * `hug.review_expired` to the same target_channels as the
 * original request. Runs every 60 s (configurable).
 *
 * Also fires Hub-owned reminders for pending reviews with
 * `remind_every_minutes` set (replaces daemon POST /reviews/remind).
 */
async function sweep(): Promise<void> {
    const sq = get_sequelize();

    /** Atomically expire pending reviews past their timeout. */
    const [results] = await sq.query(
        `UPDATE cliq."reviews"
            SET "status" = 'expired'
          WHERE "status" = 'pending'
            AND "timeout_at" < NOW()
      RETURNING "id", "run_id", "daemon_id", "realm_id"`,
    );

    const expired = results as unknown as ExpiredRow[];
    if (expired && expired.length > 0) {
        for (const row of expired) {
            try {
                const notif_rows = await ReviewNotification.findAll({
                    where: { review_id: row.id },
                    attributes: ['channel_id'],
                });
                const channels = [
                    ...new Set(
                        notif_rows
                            .map((r) => r.channel_id)
                            .filter((cid): cid is string => cid != null),
                    ),
                ];

                const hub_url = (
                    process.env.PUBLIC_APP_URL
                    || process.env.CLIQHUB_PUBLIC_URL
                    || 'https://cliqhub.io'
                ).replace(/\/+$/, '');

                await EventSubmitService.submit({
                    type: 'hug.review_expired',
                    realm_id: row.realm_id ?? undefined,
                    run_id: row.run_id,
                    daemon_id: row.daemon_id ?? undefined,
                    payload: {
                        review_id: row.id,
                        review_url: `${hub_url}/reviews/${row.id}`,
                    },
                    target_channels: channels,
                });
            } catch (err) {
                console.error(`[ReviewExpirySweep] event emit failed for ${row.id}:`, err);
            }
        }
    }

    await sweep_reminders(sq);
}

/** Fire due Hub-owned reminders (remind_every_minutes). */
async function sweep_reminders(sq: ReturnType<typeof get_sequelize>): Promise<void> {
    const due = await sq.query(
        `SELECT "id"
           FROM cliq."reviews"
          WHERE "status" = 'pending'
            AND "remind_every_minutes" IS NOT NULL
            AND "remind_every_minutes" > 0
            AND (
                  ("last_reminded_at" IS NULL
                   AND "created_at" + ("remind_every_minutes" * INTERVAL '1 minute') <= NOW())
               OR ("last_reminded_at" IS NOT NULL
                   AND "last_reminded_at" + ("remind_every_minutes" * INTERVAL '1 minute') <= NOW())
            )
          LIMIT 100`,
        { type: QueryTypes.SELECT },
    ) as RemindRow[];

    for (const row of due) {
        try {
            await HugReviewsService.remind(row.id);
        } catch (err) {
            console.error(`[ReviewExpirySweep] remind failed for ${row.id}:`, err);
        }
    }
}

/** Start the periodic review expiry + remind sweep. */
export function start_review_expiry_sweep(): void {
    if (_timer) return;

    sweep().catch((err) => {
        console.error('[ReviewExpirySweep] initial sweep failed:', err);
    });

    _timer = setInterval(() => {
        sweep().catch((err) => {
            console.error('[ReviewExpirySweep] sweep failed:', err);
        });
    }, SWEEP_INTERVAL_MS);
    _timer.unref();
}

/** Stop the sweep (for graceful shutdown). */
export function stop_review_expiry_sweep(): void {
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}

/** Test hook — run one sweep cycle. */
export async function run_review_sweep_once(): Promise<void> {
    await sweep();
}
