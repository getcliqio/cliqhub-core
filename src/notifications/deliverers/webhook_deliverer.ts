import { createHmac, randomUUID } from 'node:crypto';

import { AbstractChannelDeliverer, type DeliveryContext } from './abstract_channel_deliverer.js';
import type { NotificationPayload } from '../types.js';
import { get_logger } from '../../lib/log.js';
import { WebhookDelivery } from '../../models/index.js';

const log = get_logger('notify.webhook');

// Header names match the GitHub webhook convention (X-Hub-Signature-256)
// closely enough to feel familiar, but scoped under X-Cliq-* so a receiver
// listening for both providers can dispatch cleanly on prefix.
const HEADER_EVENT = 'X-Cliq-Event';
const HEADER_DELIVERY = 'X-Cliq-Delivery';
const HEADER_TIMESTAMP = 'X-Cliq-Timestamp';
const HEADER_SIGNATURE = 'X-Cliq-Signature';

/**
 * Sign the payload for a shared-secret webhook.
 *
 * Signature format: `sha256=<hex>` where hex is
 *   HMAC-SHA256(secret, `${unix_seconds}.${body}`)
 *
 * Receiver verifies by recomputing over the same `timestamp + '.' + body`
 * and constant-time comparing. Including the timestamp inside the signed
 * material (not just as a sibling header) is what lets the receiver reject
 * replayed bodies whose timestamp header has been rewritten.
 */
export function sign_webhook_body(
	secret: string,
	body: string,
	timestamp: string,
): string {
	const mac = createHmac('sha256', secret);
	mac.update(`${timestamp}.${body}`);
	return `sha256=${mac.digest('hex')}`;
}

export class WebhookDeliverer extends AbstractChannelDeliverer {
	readonly provider = 'webhook';

	async deliver(
		config: Record<string, unknown>,
		payload: NotificationPayload,
		context?: DeliveryContext,
	): Promise<void> {
		const url = config.url;
		if (typeof url !== 'string' || !url) {
			log.warn('Webhook channel missing url');
			return;
		}

		const body = JSON.stringify(payload);
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };

		// User-supplied extra headers layer on top of Content-Type but under
		// our signing headers — a caller cannot silently forge a signature
		// header via `config.headers.X-Cliq-Signature: whatever`.
		const extra = config.headers;
		if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
			for (const [key, value] of Object.entries(extra as Record<string, unknown>)) {
				if (typeof value === 'string') headers[key] = value;
			}
		}

		const secret = config.secret;
		if (typeof secret === 'string' && secret.length > 0) {
			const timestamp = String(Math.floor(Date.now() / 1000));
			headers[HEADER_EVENT] = payload.event;
			headers[HEADER_DELIVERY] = randomUUID();
			headers[HEADER_TIMESTAMP] = timestamp;
			headers[HEADER_SIGNATURE] = sign_webhook_body(secret, body, timestamp);
		}

		const start = Date.now();
		let status_code: number | null = null;
		let error_msg: string | null = null;

		try {
			const res = await fetch(url, {
				method: 'POST',
				headers,
				body,
			});
			status_code = res.status;
			if (!res.ok) {
				log.warn(`Webhook returned ${res.status}`);
				error_msg = `HTTP ${res.status}`;
			}
		} catch (err) {
			// Network / DNS / connection error — no HTTP response ever arrived.
			// Record status_code null so the audit table can distinguish
			// "receiver rejected the request" from "we never reached them".
			error_msg = err instanceof Error ? err.message : String(err);
			log.warn(`Webhook fetch failed: ${error_msg}`);
		}

		const response_ms = Date.now() - start;

		// Best-effort audit write. Skipped when no channel_id — v2
		// destination fan-out (channel_ref, ad-hoc destinations) doesn't
		// have an owning channel row to attribute against, so we can't
		// scope the audit and shouldn't stuff nulls into a NOT NULL
		// column. Also silently swallow insert failures so a downed
		// audit table doesn't take down live delivery.
		const channel_id = context?.channel_id;
		if (channel_id) {
			try {
				await WebhookDelivery.create({
					id: randomUUID(),
					channel_id,
					event_type: payload.event,
					url,
					status_code,
					response_ms,
					attempted_at: start,
					error: error_msg,
				});
			} catch (err) {
				log.warn(`webhook audit insert failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// Re-throw network errors so fan_out can emit notification.failed.
		// Non-2xx responses do NOT throw (existing behavior) — matches the
		// pre-1.4 contract where the deliverer treats HTTP status errors
		// as best-effort delivered.
		if (status_code === null && error_msg) {
			throw new Error(error_msg);
		}
	}
}
