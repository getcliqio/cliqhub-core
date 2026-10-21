import { get_logger } from '../lib/log.js';
import type { SubmittedEvent } from '../services/events_service.js';
import { EventSubmitService } from '../services/events_service.js';
import { DaemonRepository } from '../repositories/daemon_repository.js';
import { RunRepository } from '../repositories/run_repository.js';
import { NotificationService } from '../services/notification.service.js';
import { OrgSeedService, default_rule_specs, ORG_EMAIL_CHANNEL_KEY } from '../services/org_seed.service.js';
import { raise_unknown_channel } from './unknown_channel.js';
import { get_deliverer } from './deliverers/index.js';
import {
	event_title,
	is_channel_provider,
	type NotificationDispatchStatus,
	type NotificationPayload,
} from './types.js';
import type { Destination } from './channel_config.js';
import { EventSends, type DeliveryContext } from './deliverers/abstract_channel_deliverer.js';
import { ORG_IN_APP_CHANNEL_KEY, REALM_MEMBERS_CHANNEL_KEY } from './defaults.js';
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
	 * those channels; otherwise the realm's rules (else the org's). A realm's
	 * defaults are ordinary rules on its "All realm members" channel.
	 */
	static async notify_realm(event: SubmittedEvent): Promise<NotificationDispatchStatus> {
		const realm_id = event.realm_id?.trim();
		if (!realm_id) return 'skipped';

		const intent = read_notify_channels_intent(event.payload ?? undefined) ?? await run_notify_channels(event);
		const plan = plan_fan_out(intent);

		if (plan.action === 'mute') return 'skipped';

		if (plan.action === 'refs') {
			const { ids, missing } = await resolve_channel_refs(realm_id, plan.refs);
			// A named channel that doesn't exist reaches the realm as Unknown channel (once per run per name).
			if (event.type !== 'notification.unknown_channel') {
				for (const name of missing) {
					await raise_unknown_channel({
						realm_id, name, source: 'notify_channels', for_event: event.type,
						run_id: event.run_id ?? null, phase: event.phase ?? null, team: event.team ?? null, daemon_id: event.daemon_id ?? null,
					});
				}
			}
			if (ids.length === 0) {
				log.warn(`notify refs unresolved for ${event.type} — Unknown channel raised`);
				return 'failed';
			}
			return deliver_for_channel_ids(ids, event);
		}

		const org_id = event.org_id ? String(event.org_id) : undefined;
		const channel_ids = await NotificationService.resolve_rules({
			event: event.type,
			realm_id,
			org_id,
		});

		if (channel_ids.length > 0) {
			return deliver_for_channel_ids(channel_ids, event);
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
	 * Org event delivery (invites, org lifecycle, account emails).
	 *
	 * Built-in messages first: the invite and account messages in
	 * {@link default_rule_specs} always reach their people — one email per
	 * recipient, and one inbox row per recipient account — whatever rules the
	 * org has. Links built from `link` go only to the recipient they belong to
	 * (the invitee, or the user of a password link). Then every rule people
	 * added for the event delivers to its channel's destinations, as for any
	 * event. Never throws for delivery failures.
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

		// 1. Built-in messages: not rules, not channels — they always go to their people.
		const account = await OrgSeedService.is_account_org(org_id);
		for (const spec of default_rule_specs(account).filter((m) => m.event === type)) {
			const rule_id = `built-in:${spec.system_key}`;
			const recipients = await resolve_recipients(spec.recipients, { org_id, data: org_payload.data });
			if (spec.channel === ORG_EMAIL_CHANNEL_KEY) {
				for (const r of recipients) {
					const key = `email|${r.email}`;
					if (done.has(key)) continue;
					done.add(key);
					deliveries.push(await deliver_org_email(event, org_payload, null, {}, r, links_for, rule_id));
				}
				continue;
			}
			// The inbox is for people who can sign in: an invited person without an account gets nothing here.
			const active = await active_account_ids(recipients.map((r) => r.user_id));
			for (const r of recipients) {
				const key = `inbox|${r.user_id}`;
				if (!r.user_id || !active.has(r.user_id) || done.has(key)) continue;
				done.add(key);
				const to_self = r.selector === link_recipient(type);
				const words = describe_org_event_for_inbox(type, org_payload.data, to_self, await names());
				// An invitee is not a member of the org yet: their "You're invited" lands in their own account org's inbox.
				const own = to_self && is_invite_event(type) ? await account_org_id(r.user_id) : null;
				deliveries.push(own
					? await deliver_inbox({ ...payload, ...words, realm_id: null }, null, r.user_id, rule_id, own)
					: await deliver_inbox({ ...payload, ...words }, null, r.user_id, rule_id, org_id));
			}
		}

		// 2. Rules people added for the event: their channels' destinations, like any event.
		const rules = await NotificationService.resolve_org_rules({ event: event.type, org_id });
		const channels = new Map(
			(await NotificationService.find_enabled_channels([...new Set(rules.map((r) => r.channel_id))]))
				.map((c) => [c.id, c]),
		);
		for (const rule of rules) {
			const channel = channels.get(rule.channel_id);
			if (!channel || done.has(`${channel.id}|channel`)) continue;
			done.add(`${channel.id}|channel`);
			const destinations = parse_channel_destinations(channel);
			const ok = await deliver_destinations(destinations, payload, new Set(), { channel_id: channel.id }, (channel as unknown as { secret: string | null }).secret ?? null);
			deliveries.push({ channel_id: channel.id, rule_id: rule.id, type: 'channel', to: null, with_links: false, ok, error: ok ? null : 'no destination accepted the event' });
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
/** Channel ids for the named refs in a realm, and the names that matched no channel. */
async function resolve_channel_refs(realm_id: string, refs: string[]): Promise<{ ids: string[]; missing: string[] }> {
	const ids: string[] = [];
	const missing: string[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		const candidates = [ref];
		const colon = ref.indexOf(':');
		if (colon >= 0 && colon < ref.length - 1) {
			candidates.push(ref.slice(colon + 1));
		}
		let found = false;
		for (const name of candidates) {
			const ch = await NotificationService.find_realm_usable_channel(name, realm_id);
			if (!ch) continue;
			found = true;
			if (seen.has(ch.id)) break;
			seen.add(ch.id);
			ids.push(ch.id);
			break;
		}
		if (!found && !missing.includes(ref)) missing.push(ref);
	}
	return { ids, missing };
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
	const found = await NotificationService.find_enabled_channels(channel_ids);
	if (found.length === 0) return 'skipped';

	const payload = await to_payload(event);
	let failures = 0;
	// One event: each endpoint gets it once. Shared channels first, so their in-app notice covers members
	// before any personal copy is considered.
	const sends = new EventSends();
	const channels = [...found].sort((a, b) => Number(Boolean((a as { user_id?: unknown }).user_id)) - Number(Boolean((b as { user_id?: unknown }).user_id)));

	for (const channel of channels) {
		const destinations = parse_channel_destinations(channel);
		const members_way = MEMBERS_CHANNEL_KEYS.has(String((channel as { system_key?: unknown }).system_key ?? ''));
		if (destinations.length === 0 && !members_way) {
			log.warn(`skip channel ${channel.id}: no destinations configured`);
			failures += 1;
			continue;
		}

		/** Column-based webhook secret wins over any secret carried inside
		 *  the destination config. This is what makes `rotate_channel_secret`
		 *  actually take effect at delivery time. */
		const channel_secret = (channel as unknown as { secret: string | null }).secret ?? null;

		let ok = await deliver_destinations(
			destinations, payload, new Set(),
			{ channel_id: channel.id, sends },
			channel_secret,
		);
		// "All org / realm members": each member also gets it their way (their personal channel's other destinations).
		if (members_way && await deliver_to_members_their_way(channel, payload, sends)) ok = true;
		if (!ok) {
			failures += 1;
			emit_notification_failed(event, channel.id, `All destinations failed for channel '${channel.name}'`).catch(() => {});
		}
	}

	if (failures > 0 && failures >= channels.length) return 'failed';
	return 'dispatched';
}

/** The built-in channels whose audience is their members, each reached their own way. */
const MEMBERS_CHANNEL_KEYS: ReadonlySet<string> = new Set([ORG_IN_APP_CHANNEL_KEY, REALM_MEMBERS_CHANNEL_KEY]);

/**
 * "All org members" / "All realm members": every member (active org members; the realm's member users) gets the
 * event through their personal channel's destinations other than in-app — the channel's own in-app notice already
 * reaches them. Shares the event's sends, so nobody gets an endpoint twice. True when anything was delivered.
 */
async function deliver_to_members_their_way(channel: unknown, payload: NotificationPayload, sends: EventSends): Promise<boolean> {
	const c = channel as { id: string; realm_id?: string | null; org_id?: string | null };
	const { RealmMember, OrgMember, User, NotificationChannel, ChannelDestination } = await import('../models/index.js');
	const ids = c.realm_id
		? (await RealmMember.findAll({ where: { realm_id: c.realm_id, member_type: 'user' } as never, attributes: ['member_id'], raw: true })).map((m) => String((m as { member_id: string }).member_id))
		: c.org_id
			? (await OrgMember.findAll({ where: { org_id: c.org_id, status: 'active' } as never, attributes: ['user_id'], raw: true })).map((m) => String((m as { user_id: string }).user_id))
			: [];
	if (ids.length === 0) return false;
	// Only people who can be reached (not suspended or deleted).
	const people = (await User.findAll({ where: { id: ids, status: 'active', deleted_at: null } as never, attributes: ['id'], raw: true })).map((u) => String((u as { id: string }).id));
	if (people.length === 0) return false;
	const personal = await NotificationChannel.findAll({
		where: { user_id: people, enabled: 1 } as never,
		include: [{ model: ChannelDestination, as: 'destinations_rows' }],
	});
	let any = false;
	for (const pc of personal) {
		const dests = parse_channel_destinations(pc).filter((d) => d.type !== 'cliqhub');
		if (dests.length === 0) continue;
		const secret = (pc as unknown as { secret: string | null }).secret ?? null;
		if (await deliver_destinations(dests, payload, new Set(), { channel_id: pc.id, sends }, secret)) any = true;
	}
	return any;
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

			// Within the event's realm and its org (never another org's channel of the same name).
			const target = payload.realm_id
				? await NotificationService.find_realm_usable_channel(dest.name, String(payload.realm_id))
				: await NotificationService.find_channel_by_name(dest.name);
			if (!target) {
				log.warn(`channel_ref '${dest.name}' not found, skipping`);
				continue;
			}

			const child_dests = parse_channel_destinations(target);
			if (child_dests.length > 0) {
				const child_secret = (target as unknown as { secret: string | null }).secret ?? null;
				const ok = await deliver_destinations(
					child_dests, payload, visited,
					{ channel_id: target.id, sends: context?.sends }, child_secret,
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

		// Once per event: a Slack or webhook URL already posted to is skipped.
		const url = provider === 'slack' ? config.webhook_url : provider === 'webhook' ? config.url : null;
		if (context?.sends && typeof url === 'string' && url && !context.sends.take(`${provider}|${url}`)) {
			any_success = true;
			continue;
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
export function destination_to_config(dest: Destination): Record<string, unknown> {
	switch (dest.type) {
		case 'slack':
			return { webhook_url: dest.webhook_url };
		case 'email':
			return { to: dest.address, cc: dest.cc, bcc: dest.bcc, account: dest.account, members: dest.members };
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
	// A title that is just the event type ("run.failed") reads as missing.
	const given = event.title?.trim();
	if (given && given !== event.type) return given;
	return [event_title(event.type), run_name, phase].filter(Boolean).join(' · ');
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
	// A failed or crashed run says why (Core's own end-of-run event carries the error, not a message).
	const error = typeof event.payload?.error === 'string' ? event.payload.error.trim() : '';
	if (error) return error.length > 500 ? `${error.slice(0, 500)}…` : error;

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
	channel_id: string | null,
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
async function deliver_inbox(payload: NotificationPayload, channel_id: string | null, user_id: string, rule_id: string, org_id: string): Promise<OrgDeliveryOutcome> {
	try {
		await InAppNotificationService.create_from_payload(payload, user_id, org_id);
		return { channel_id, rule_id, type: 'cliqhub', to: user_id, with_links: false, ok: true, error: null };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		log.error('org_inbox_failed', { event: payload.event, channel_id, error });
		return { channel_id, rule_id, type: 'cliqhub', to: user_id, with_links: false, ok: false, error };
	}
}
