import { get_logger } from '../lib/log.js';
import type { SubmittedEvent } from '../services/events_service.js';
import { EventSubmitService } from '../services/events_service.js';
import { DaemonRepository } from '../repositories/daemon_repository.js';
import { RunRepository } from '../repositories/run_repository.js';
import { NotificationService } from '../services/notification.service.js';
import { get_deliverer } from './deliverers/index.js';
import {
	is_channel_provider,
	type NotificationDispatchStatus,
	type NotificationPayload,
} from './types.js';
import type { Destination } from './channel_config.js';
import type { DeliveryContext } from './deliverers/abstract_channel_deliverer.js';
import { DELIVERER_BY_PROVIDER } from './deliverers/index.js';
import type { EmailDeliverer } from './deliverers/email_deliverer.js';
import { plan_fan_out, read_notify_channels_intent } from './notify_intent.js';
import { InAppNotificationService } from '../services/in_app_notification.service.js';
import { resolve_delivery_links } from './delivery_links.js';
import { resolve_recipients, type ResolvedRecipient } from './recipients.js';
import {
	describe_org_event_for_inbox,
	is_invite_event,
	type DeliveryLinkRef,
	type DeliveryLinks,
	type OrgDeliveryOutcome,
	type OrgEventPayload,
	type OrgEventType,
} from './org_events.js';
import type { EmailSubjectType } from '../models/email_delivery.model.js';
import { RUN_NOTIFY_OVERRIDE_EVENTS } from '../services/run_start_options.js';

const log = get_logger('notify.fanout');
const _fan_out_daemon_repo = new DaemonRepository();
const _fan_out_run_repo = new RunRepository();

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

		const intent = read_notify_channels_intent(event.payload ?? undefined) ?? await run_notify_channels(event);
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

	/**
	 * Org event delivery (invites, org lifecycle, account emails): every org
	 * rule matching the event fires. A rule with `recipients` delivers to the
	 * resolved people — one email per recipient on email destinations, one
	 * inbox row per recipient account on in-app destinations — and other
	 * destination types once; a rule without recipients delivers to the
	 * channel's own destinations as for any event. Links built from `link`
	 * go only to the recipient they belong to (the invitee, or the user of a
	 * password link). Never throws for delivery failures.
	 *
	 * @param event - The stored org event (`payload` is {@link OrgEventPayload}).
	 * @param link - Where the email link comes from, when the event carries one.
	 */
	static async notify_org(
		event: SubmittedEvent,
		link?: DeliveryLinkRef,
	): Promise<{ status: NotificationDispatchStatus; deliveries: OrgDeliveryOutcome[] }> {
		const org_id = event.org_id ? String(event.org_id) : '';
		if (!org_id) return { status: 'skipped', deliveries: [] };

		const rules = await NotificationService.resolve_org_rules({ event: event.type, org_id });
		if (rules.length === 0) return { status: 'skipped', deliveries: [] };
		const channels = new Map(
			(await NotificationService.find_enabled_channels([...new Set(rules.map((r) => r.channel_id))]))
				.map((c) => [c.id, c]),
		);

		const org_payload = event.payload as unknown as OrgEventPayload;
		const payload = await to_payload(event);
		const type = event.type as OrgEventType;
		let names_once: Promise<{ accepted: string | null }> | null = null;
		const names = () => (names_once ??= accepted_name(org_payload.data));
		let links: Promise<DeliveryLinks> | null = null;
		const links_for = (r: ResolvedRecipient): Promise<DeliveryLinks> => {
			if (!link || r.selector !== link_recipient(type)) return Promise.resolve({});
			return (links ??= resolve_delivery_links(link));
		};

		const deliveries: OrgDeliveryOutcome[] = [];
		const done = new Set<string>();
		for (const rule of rules) {
			const channel = channels.get(rule.channel_id);
			if (!channel) continue;
			const destinations = parse_channel_destinations(channel);

			if (!rule.recipients || rule.recipients.length === 0) {
				if (done.has(`${channel.id}|channel`)) continue;
				done.add(`${channel.id}|channel`);
				const ok = await deliver_destinations(destinations, payload, new Set(), { channel_id: channel.id }, (channel as unknown as { secret: string | null }).secret ?? null);
				deliveries.push({ channel_id: channel.id, rule_id: rule.id, type: 'channel', to: null, with_links: false, ok, error: ok ? null : 'no destination accepted the event' });
				continue;
			}

			const recipients = await resolve_recipients(rule.recipients, { org_id, data: org_payload.data });
			for (const dest of destinations) {
				if (dest.type === 'email') {
					for (const r of recipients) {
						const key = `${channel.id}|email|${r.email}`;
						if (done.has(key)) continue;
						done.add(key);
						deliveries.push(await deliver_org_email(event, org_payload, channel.id, dest as unknown as Record<string, unknown>, r, links_for, rule.id));
					}
				} else if (dest.type === 'cliqhub') {
					// The inbox is for people who can sign in: an invited person without an account gets nothing here.
					const active = await active_account_ids(recipients.map((r) => r.user_id));
					for (const r of recipients) {
						const key = `${channel.id}|inbox|${r.user_id}`;
						if (!r.user_id || !active.has(r.user_id) || done.has(key)) continue;
						done.add(key);
						const to_self = r.selector === link_recipient(type);
						const words = describe_org_event_for_inbox(type, org_payload.data, to_self, await names());
						// An invitee is not a member of the org yet: their "You're invited" lands in their own account org's inbox.
						const own = to_self && is_invite_event(type) ? await account_org_id(r.user_id) : null;
						deliveries.push(own
							? await deliver_inbox({ ...payload, ...words, realm_id: null }, channel.id, r.user_id, rule.id, own)
							: await deliver_inbox({ ...payload, ...words }, channel.id, r.user_id, rule.id, org_id));
					}
				} else {
					const key = `${channel.id}|${dest.type}|${JSON.stringify(dest)}`;
					if (done.has(key)) continue;
					done.add(key);
					const ok = await deliver_destinations([dest], payload, new Set(), { channel_id: channel.id });
					deliveries.push({ channel_id: channel.id, rule_id: rule.id, type: dest.type, to: null, with_links: false, ok, error: ok ? null : 'delivery failed' });
				}
			}
		}

		if (deliveries.length === 0) return { status: 'skipped', deliveries };
		return { status: deliveries.some((d) => d.ok) ? 'dispatched' : 'failed', deliveries };
	}

	/** @deprecated Prefer notify_realm / notify_account via family handlers. */
	static async notify(event: SubmittedEvent): Promise<NotificationDispatchStatus> {
		return this.notify_realm(event);
	}
}


/**
 * The notification channels chosen when the event's run was started, for the
 * run lifecycle events they cover; undefined when there are none.
 */
async function run_notify_channels(event: SubmittedEvent): Promise<string[] | undefined> {
	const run_id = event.run_id?.trim();
	if (!run_id || !RUN_NOTIFY_OVERRIDE_EVENTS.has(event.type)) return undefined;
	const run = await _fan_out_run_repo.find_by_id(run_id);
	const raw = run?.notify_channels;
	if (!raw) return undefined;
	try {
		const refs = JSON.parse(raw) as unknown;
		return Array.isArray(refs) && refs.length > 0 ? refs.filter((r): r is string => typeof r === 'string') : undefined;
	} catch {
		return undefined;
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
			const run = await _fan_out_run_repo.find_by_id(run_id);
			run_name = String(run?.get('run_name') ?? '').trim();
		} catch (err) { log.debug('fanout_lookup_failed', { error: err instanceof Error ? err.message : String(err) }); /* ignore lookup errors */ }
	}

	const daemon_id = event.daemon_id?.trim();
	if (!daemon_name && daemon_id) {
		try {
			const daemon = await _fan_out_daemon_repo.find_by_id(daemon_id);
			daemon_name = String(daemon?.get('name') ?? daemon?.get('hostname') ?? '').trim();
		} catch (err) { log.debug('fanout_lookup_failed', { error: err instanceof Error ? err.message : String(err) }); /* ignore */ }
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

/** The selector whose recipient gets an event's links: the invitee for invites, the user for account emails. */
function link_recipient(type: OrgEventType): 'invitee' | 'user' {
	return is_invite_event(type) ? 'invitee' : 'user';
}

/** What `email_deliveries` records an org-event email against. */
function email_subject(type: OrgEventType, payload: OrgEventPayload): { type: EmailSubjectType; id: string } {
	const data = payload.data as unknown as Record<string, unknown>;
	if (typeof data.invite_id === 'string') return { type: 'invite', id: data.invite_id };
	if (typeof data.reset_id === 'string') return { type: 'reset', id: data.reset_id };
	const user = data.user as { id: string };
	return { type: 'user', id: user.id };
}

/** Sends one org-event email through the Email deliverer. */
async function deliver_org_email(
	event: SubmittedEvent,
	payload: OrgEventPayload,
	channel_id: string,
	destination: Record<string, unknown>,
	to: ResolvedRecipient,
	links_for: (r: ResolvedRecipient) => Promise<DeliveryLinks>,
	rule_id: string,
): Promise<OrgDeliveryOutcome> {
	const type = event.type as OrgEventType;
	try {
		const links = await links_for(to);
		const { type: _type, ...dest_config } = destination;
		const result = await (DELIVERER_BY_PROVIDER.email as EmailDeliverer).deliver_message({
			event: type,
			event_id: event.id,
			org_id: String(event.org_id),
			realm_id: event.realm_id,
			channel_id,
			occurred_at: event.occurred_at,
			actor: payload.actor,
			data: payload.data,
			links,
			to,
			subject: email_subject(type, payload),
			destination: dest_config,
		});
		return { channel_id, rule_id, type: 'email', to: to.email, with_links: Object.keys(links).length > 0, ok: result.sent, error: result.error };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		log.error('org_email_failed', { event: type, event_id: event.id, channel_id, error });
		return { channel_id, rule_id, type: 'email', to: to.email, with_links: false, ok: false, error };
	}
}

/** Of `ids`, the users with an active, live account. */
async function active_account_ids(ids: Array<string | null>): Promise<Set<string>> {
	const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
	if (!wanted.length) return new Set();
	const { User } = await import('../models/index.js');
	const rows = await User.findAll({ where: { id: wanted, status: 'active', deleted_at: null }, attributes: ['id'], raw: true });
	return new Set(rows.map((u) => String(u.id)));
}

/** The live account org of a user (slug = username), or null. */
async function account_org_id(user_id: string): Promise<string | null> {
	const { Org, User } = await import('../models/index.js');
	const user = await User.findByPk(user_id, { attributes: ['username'], raw: true });
	if (!user?.username) return null;
	const org = await Org.findOne({ where: { slug: user.username, deleted_at: null }, attributes: ['id'], raw: true });
	return org ? String(org.id) : null;
}

/** Display name of the person who accepted an invite (null when the event is not an accept). */
async function accepted_name(data: OrgEventPayload['data']): Promise<{ accepted: string | null }> {
	const accepted = (data as { accepted_user?: { id: string } }).accepted_user;
	if (!accepted) return { accepted: null };
	const { User } = await import('../models/index.js');
	const row = await User.findByPk(accepted.id, { attributes: ['display_name', 'username'], raw: true });
	return { accepted: row?.display_name || row?.username || null };
}

/** Writes one in-app notification for one recipient account, in the event's org. */
async function deliver_inbox(payload: NotificationPayload, channel_id: string, user_id: string, rule_id: string, org_id: string): Promise<OrgDeliveryOutcome> {
	try {
		await InAppNotificationService.create_from_payload(payload, user_id, org_id);
		return { channel_id, rule_id, type: 'cliqhub', to: user_id, with_links: false, ok: true, error: null };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		log.error('org_inbox_failed', { event: payload.event, channel_id, error });
		return { channel_id, rule_id, type: 'cliqhub', to: user_id, with_links: false, ok: false, error };
	}
}
