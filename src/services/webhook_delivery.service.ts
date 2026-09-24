/**
 * webhook_deliveries — recent attempt audit trail per channel.
 *
 * The deliverer writes one row per attempt (see webhook_deliverer.ts);
 * this service reads them back for the SPA / Forge plugin "recent
 * deliveries" table and runs a nightly sweep so the table doesn't grow
 * without bound.
 *
 * See DESIGN-jira-forge-plugin slice 1.4.
 */

import { Op } from 'sequelize';

import { WebhookDelivery } from '../models/index.js';

const RETENTION_DAYS = parseInt(
    process.env.WEBHOOK_DELIVERY_RETENTION_DAYS ?? '30', 10,
);
const RETENTION_INTERVAL_MS = parseInt(
    process.env.WEBHOOK_DELIVERY_RETENTION_INTERVAL_MS ?? String(24 * 60 * 60 * 1000), 10,
);

export interface WebhookDeliveryRecord {
    id: string;
    channel_id: string;
    event_type: string;
    url: string;
    status_code: number | null;
    response_ms: number | null;
    attempted_at: number;
    error: string | null;
}

let _retention_timer: ReturnType<typeof setInterval> | null = null;

export class WebhookDeliveryService {

    /**
     * Recent attempts for a channel, newest first. Default limit 20 —
     * enough to spot a repeating failure pattern without paging the
     * caller off a cliff. Callers can bump up to 200 for a full
     * debugging session.
     */
    static async list_by_channel(
        channel_id: string,
        limit: number = 20,
    ): Promise<WebhookDeliveryRecord[]> {
        const clamped = Math.max(1, Math.min(200, Math.floor(limit)));
        const rows = await WebhookDelivery.findAll({
            where: { channel_id },
            order: [['attempted_at', 'DESC']],
            limit: clamped,
        });
        return rows.map(_to_record);
    }

    /** Delete rows older than `days`. Returns the number pruned. */
    static async prune_older_than(days: number = RETENTION_DAYS): Promise<number> {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        return WebhookDelivery.destroy({
            where: { attempted_at: { [Op.lt]: cutoff } },
        });
    }
}

/**
 * Start the nightly retention sweep. Idempotent — repeated calls
 * (test setup, dev-server reload) are no-ops. First scan fires
 * immediately to catch any stale rows from a previous process.
 */
export function start_webhook_delivery_retention(): void {
    if (_retention_timer) return;
    console.log(
        `[WebhookDeliveryRetention] started `
        + `(interval=${RETENTION_INTERVAL_MS}ms, retention=${RETENTION_DAYS}d)`,
    );

    WebhookDeliveryService.prune_older_than().catch((err) => {
        console.error(
            '[WebhookDeliveryRetention] initial sweep failed:',
            err instanceof Error ? err.message : err,
        );
    });

    _retention_timer = setInterval(() => {
        WebhookDeliveryService.prune_older_than().catch((err) => {
            console.error(
                '[WebhookDeliveryRetention] sweep failed:',
                err instanceof Error ? err.message : err,
            );
        });
    }, RETENTION_INTERVAL_MS);
    _retention_timer.unref();
}

export function stop_webhook_delivery_retention(): void {
    if (_retention_timer) {
        clearInterval(_retention_timer);
        _retention_timer = null;
    }
}

function _to_record(
    row: InstanceType<typeof WebhookDelivery>,
): WebhookDeliveryRecord {
    const plain = (row as unknown as { toJSON: () => WebhookDeliveryRecord }).toJSON();
    return {
        id: plain.id,
        channel_id: plain.channel_id,
        event_type: plain.event_type,
        url: plain.url,
        status_code: plain.status_code === null ? null : Number(plain.status_code),
        response_ms: plain.response_ms === null ? null : Number(plain.response_ms),
        attempted_at: Number(plain.attempted_at),
        error: plain.error,
    };
}
