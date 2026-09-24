import { get_logger } from '../lib/log.js';
import type { SubmittedEvent } from '../events/submit.service.js';
import { EventSubmitService } from '../events/submit.service.js';
import { Daemon, Run } from '../models/index.js';
import { NotificationService } from '../services/notification.service.js';
import { get_deliverer } from './deliverers/index.js';
import {
	is_channel_provider,
	type NotificationDispatchStatus,
	type NotificationPayload,
} from './types.js';
import type { Destination } from './channel_config.js';
import type { DeliveryContext } from './deliverers/abstract_channel_deliverer.js';
import { plan_fan_out, read_notify_channels_intent } from './notify_intent.js';

const log = get_logger('notify.fanout');

export class NotificationFanOutService {
	/**
	 * Realm-scoped delivery (Yamazaki H3.3).
	 *
	 * Precedence: payload.notify.channels false → mute; non-empty refs →
	 * those channels; absent/`[]` + default-notify → Hub notification
	 * rules if any match, else realm:all_users; otherwise rules only.
	 *
	 * Hub rules win over the all-users default so operators can route
	 * run.failed / phase.input_required to Slack/webhook without the
	 * built-in in-app channel swallowing the event.
	 */
	static async notify_realm(event: SubmittedEvent): Promise<NotificationDispatchStatus> {
		const realm_id = event.realm_id?.trim();
		if (!realm_id) return 'skipped';

		const intent = read_notify_channels_intent(event.payload ?? undefined);
		const plan = plan_fan_out(event.type, intent);

		if (plan.action === 'mute') return 'skipped';

		if (plan.action === 'refs') {
			const ids = await resolve_channel_refs(realm_id, plan.refs);
			if (ids.length === 0) {
				log.warn(`notify refs unresolved for ${event.type} — skipping`);
				return 'skipped';
			}
			return deliver_for_channel_ids(ids, event);
		}

		const org_id = event.org_id ? String(event.org_id) : undefined;
		const channel_ids = await NotificationService.resolve_rules({
			event: event.type,
			realm_id,
			team_slug: event.team?.trim() || null,
			org_id,
		});

		if (channel_ids.length > 0) {
			return deliver_for_channel_ids(channel_ids, event);
		}

		if (plan.action === 'all_users') {
			const ch = await NotificationService.ensure_realm_all_users_channel(realm_id);
			return deliver_for_channel_ids([ch.id], event);
		}

		return 'skipped';
	}

	/**
	 * Account-scoped event delivery via notification rules.
	 *
	 * Uses global-tier rules only.
	 */
	static async notify_account(event: SubmittedEvent): Promise<NotificationDispatchStatus> {
		const org_id = event.org_id ? String(event.org_id) : undefined;

		const channel_ids = await NotificationService.resolve_rules({
			event: event.type,
			org_id,
		});

		if (channel_ids.length === 0) return 'skipped';
		return deliver_for_channel_ids(channel_ids, event);
	}

	/**
	 * Deliver directly to a specific set of channel IDs (bypassing rule resolution).
	 *
	 * Used for targeted review notifications where channels are already resolved.
	 */
	static async deliver_to_channels(
		channel_ids: string[],
		event: SubmittedEvent,
	): Promise<NotificationDispatchStatus> {
		if (channel_ids.length === 0) return 'skipped';
		return deliver_for_channel_ids(channel_ids, event);
	}

	/** @deprecated Prefer notify_realm / notify_account via family handlers. */
	static async notify(event: SubmittedEvent): Promise<NotificationDispatchStatus> {
		return this.notify_realm(event);
	}
}


/**
 * Resolve team.yml-style channel refs (`slack:oncall`, bare names) to
 * Hub channel ids within the realm. Tries full ref then suffix after `:`.
 */
async function resolve_channel_refs(realm_id: string, refs: string[]): Promise<string[]> {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		const candidates = [ref];
		const colon = ref.indexOf(':');
		if (colon >= 0 && colon < ref.length - 1) {
			candidates.push(ref.slice(colon + 1));
		}
		for (const name of candidates) {
			const ch = await NotificationService.find_channel_by_name(name, realm_id);
			if (!ch) continue;
			if (seen.has(ch.id)) break;
			seen.add(ch.id);
			ids.push(ch.id);
			break;
		}
	}
	return ids;
}

/**
 * Emit a `notification.failed` event when channel delivery fails.
 * Recursion guard: never emit if the original event was itself `notification.failed`.
 */
async function emit_notification_failed(
	original_event: SubmittedEvent,
	channel_id: string,
	error_message: string,
): Promise<void> {
	if (original_event.type === 'notification.failed') return;

	try {
		await EventSubmitService.submit({
			type: 'notification.failed',
			realm_id: original_event.realm_id ?? undefined,
			severity: 'error',
			title: `Delivery failed: ${original_event.type}`,
			message: error_message,
			payload: {
				original_event_type: original_event.type,
				original_event_id: original_event.id,
				channel_id,
			},
		});
	} catch (err) {
		log.error(
			`failed to emit notification.failed: `
			+ (err instanceof Error ? err.message : String(err)),
		);
	}
}

/**
 * Deliver to a list of resolved channel IDs (from v2 rules).
 */
async function deliver_for_channel_ids(
	channel_ids: string[],
	event: SubmittedEvent,
): Promise<NotificationDispatchStatus> {
	const channels = await NotificationService.find_enabled_channels(channel_ids);
	if (channels.length === 0) return 'skipped';

	const payload = await to_payload(event);
	let failures = 0;

	for (const channel of channels) {
		const destinations = parse_channel_destinations(channel);
		if (destinations.length === 0) {
			log.warn(`skip channel ${channel.id}: no destinations configured`);
			failures += 1;
			continue;
		}

		/** Column-based webhook secret wins over any secret carried inside
		 *  the destination config. This is what makes `rotate_channel_secret`
		 *  actually take effect at delivery time. */
		const channel_secret = (channel as unknown as { secret: string | null }).secret ?? null;

		const ok = await deliver_destinations(
			destinations, payload, new Set(),
			{ channel_id: channel.id },
			channel_secret,
		);
		if (!ok) {
			failures += 1;
			emit_notification_failed(event, channel.id, `All destinations failed for channel '${channel.name}'`).catch(() => {});
		}
	}

	if (failures > 0 && failures >= channels.length) return 'failed';
	return 'dispatched';
}

// ---------------------------------------------------------------------------
// v2: recursive destination resolution
// ---------------------------------------------------------------------------

/**
 * Extract destinations from a channel. Prefers eager-loaded destination
 * rows (from the channel_destinations table); falls back to parsing the
 * legacy JSON `destinations` column for backward compatibility.
 */
/** Extract destinations from eager-loaded channel_destinations rows. */
function parse_channel_destinations(channel: unknown): Destination[] {
	const rows = (channel as any).destinations_rows;
	if (Array.isArray(rows) && rows.length > 0) {
		return rows.map((r: { type: string; config: Record<string, unknown> }) => ({
			type: r.type,
			...r.config,
		})) as Destination[];
	}
	return [];
}

/**
 * Deliver to a list of destinations, recursively resolving `channel_ref`.
 * Uses a visited set to prevent infinite loops from reference cycles.
 * Returns true if at least one destination succeeded.
 */
async function deliver_destinations(
	destinations: Destination[],
	payload: NotificationPayload,
	visited: Set<string>,
	context?: DeliveryContext,
	channel_secret: string | null = null,
): Promise<boolean> {
	let any_success = false;

	for (const dest of destinations) {
		if (dest.type === 'channel_ref') {
			if (visited.has(dest.name)) {
				log.warn(`channel_ref cycle detected at '${dest.name}', skipping`);
				continue;
			}
			visited.add(dest.name);

			const target = await NotificationService.find_channel_by_name(dest.name);
			if (!target) {
				log.warn(`channel_ref '${dest.name}' not found, skipping`);
				continue;
			}

			const child_dests = parse_channel_destinations(target);
			if (child_dests.length > 0) {
				const child_secret = (target as unknown as { secret: string | null }).secret ?? null;
				const ok = await deliver_destinations(
					child_dests, payload, visited,
					{ channel_id: target.id }, child_secret,
				);
				if (ok) any_success = true;
			}
			continue;
		}

		const config = destination_to_config(dest);
		const provider = dest.type === 'http' ? 'webhook' : dest.type;

		if (!is_channel_provider(provider)) {
			log.warn(`skip destination: unsupported type '${dest.type}'`);
			continue;
		}

		/** For webhook destinations, the column secret always wins over
		 *  any secret carried in the destination config. Both are read;
		 *  column takes precedence when set. */
		if (provider === 'webhook') {
			const dest_secret = (dest as unknown as { secret?: unknown }).secret;
			if (typeof dest_secret === 'string' && dest_secret.length > 0) {
				config.secret = dest_secret;
			}
			if (channel_secret) {
				config.secret = channel_secret;
			}
		}

		try {
			const deliverer = get_deliverer(provider);
			await deliverer.deliver(config, payload, context);
			any_success = true;
		} catch (err) {
			log.error(
				`deliver failed type=${dest.type}: `
				+ (err instanceof Error ? err.message : String(err)),
			);
		}
	}

	return any_success;
}

/**
 * Convert a typed destination to the flat config object a deliverer expects.
 */
function destination_to_config(dest: Destination): Record<string, unknown> {
	switch (dest.type) {
		case 'slack':
			return { webhook_url: dest.webhook_url };
		case 'email':
			return { to: dest.address, cc: dest.cc, bcc: dest.bcc };
		case 'webhook':
			return { url: dest.url, headers: dest.headers };
		case 'http':
			return { url: dest.url, headers: dest.headers, method: dest.method };
		case 'jira':
			return { url: dest.url, project_key: dest.project_key, issue_type: dest.issue_type, auth_header: dest.auth_header };
		case 'cliqhub':
			return {};
		default:
			return {};
	}
}

/**
 * Resolve human labels from Hub store when the event only carries ids.
 * Prefer names already on the event payload (daemon may send them).
 */
async function resolve_display_names(event: SubmittedEvent): Promise<{
	run_name: string | null;
	daemon_name: string | null;
}> {
	const from_payload = event.payload ?? {};
	let run_name = typeof from_payload.run_name === 'string' ? from_payload.run_name.trim() : '';
	let daemon_name = typeof from_payload.daemon_name === 'string'
		? from_payload.daemon_name.trim()
		: '';

	const run_id = event.run_id?.trim();
	if (!run_name && run_id) {
		try {
			const run = await Run.findByPk(run_id, { attributes: ['run_name'] });
			run_name = String(run?.get('run_name') ?? '').trim();
		} catch { /* ignore lookup errors */ }
	}

	const daemon_id = event.daemon_id?.trim();
	if (!daemon_name && daemon_id) {
		try {
			const daemon = await Daemon.findByPk(daemon_id, { attributes: ['name', 'hostname'] });
			daemon_name = String(daemon?.get('name') ?? daemon?.get('hostname') ?? '').trim();
		} catch { /* ignore */ }
	}

	return {
		run_name: run_name || null,
		daemon_name: daemon_name || null,
	};
}

function default_title(event: SubmittedEvent, run_name: string | null, phase: string | null): string {
	if (event.title?.trim()) return event.title.trim();
	return [event.type, run_name, phase].filter(Boolean).join(' · ');
}

function default_message(
	event: SubmittedEvent,
	run_name: string | null,
	daemon_name: string | null,
): string {
	const raw = event.message?.trim() || '';
	const streamish = !raw
		|| raw === event.type
		|| raw === (event.payload?.stream_event as string | undefined)
		|| /^[a-z_]+$/.test(raw);
	if (raw && !streamish) return raw;

	const bits: string[] = [];
	if (daemon_name) bits.push(daemon_name);
	if (run_name) bits.push(run_name);
	if (event.phase?.trim()) bits.push(event.phase.trim());
	if (bits.length > 0) return bits.join(' · ');
	return raw || event.type;
}

async function to_payload(event: SubmittedEvent): Promise<NotificationPayload> {
	const { run_name, daemon_name } = await resolve_display_names(event);
	const phase = event.phase?.trim() || null;

	return {
		event: event.type,
		title: default_title(event, run_name, phase),
		message: default_message(event, run_name, daemon_name),
		realm_id: event.realm_id,
		team_slug: event.team,
		run_id: event.run_id,
		phase_name: event.phase,
		severity: event.severity,
		run_name,
		daemon_name,
		daemon_id: event.daemon_id,
		...event.payload,
		// Ensure resolved names win over empty payload keys
		...(run_name ? { run_name } : {}),
		...(daemon_name ? { daemon_name } : {}),
	};
}
