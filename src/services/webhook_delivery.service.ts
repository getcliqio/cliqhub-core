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

import { get_logger } from '../lib/log.js';
import { WebhookDeliveryRepository } from '../repositories/webhook_delivery_repository.js';

const log = get_logger('svc.webhook');

const RETENTION_DAYS = parseInt(
    process.env.WEBHOOK_DELIVERY_RETENTION_DAYS ?? '30', 10,
);
const RETENTION_INTERVAL_MS = parseInt(
    process.env.WEBHOOK_DELIVERY_RETENTION_INTERVAL_MS ?? String(24 * 60 * 60 * 1000), 10,
);

const delivery_repo = new WebhookDeliveryRepository();

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
        log.debug('list_by_channel', { channel_id });
        const clamped = Math.max(1, Math.min(200, Math.floor(limit)));
        const rows = await delivery_repo.find_all(
            { channel_id },
            { order: [['attempted_at', 'DESC']], limit: clamped },
        );
        return rows.map(_to_record);
    }

    /** Delete rows older than `days`. Returns the number pruned. */
    static async prune_older_than(days: number = RETENTION_DAYS): Promise<number> {
        log.debug('prune_older_than', { days });
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const count = await delivery_repo.delete_where({ attempted_at: { [Op.lt]: cutoff } } as any);
        if (count > 0) log.info('records_deleted', { count });
        return count;
    }
}

/**
 * Start the nightly retention sweep. Idempotent — repeated calls
 * (test setup, dev-server reload) are no-ops. First scan fires
 * immediately to catch any stale rows from a previous process.
 */
export function start_webhook_delivery_retention(): void {
    log.debug('start_webhook_delivery_retention', {});
    if (_retention_timer) return;
    log.info('retention_started', { interval_ms: RETENTION_INTERVAL_MS, retention_days: RETENTION_DAYS });

    WebhookDeliveryService.prune_older_than().catch((err) => {
        log.error('retention_sweep_failed', { error: err instanceof Error ? err.message : String(err) });
    });

    _retention_timer = setInterval(() => {
        WebhookDeliveryService.prune_older_than().catch((err) => {
            log.error('retention_sweep_failed', { error: err instanceof Error ? err.message : String(err) });
        });
    }, RETENTION_INTERVAL_MS);
    _retention_timer.unref();
}

export function stop_webhook_delivery_retention(): void {
    log.debug('stop_webhook_delivery_retention', {});
    if (_retention_timer) {
        clearInterval(_retention_timer);
        _retention_timer = null;
    }
}

function _to_record(
    row: { toJSON(): WebhookDeliveryRecord },
): WebhookDeliveryRecord {    const plain = (row as unknown as { toJSON: () => WebhookDeliveryRecord }).toJSON();
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
