import { randomBytes, randomUUID } from 'node:crypto';
import { Op } from 'sequelize';

import { get_logger } from '../lib/log.js';
import { NotificationChannelRepository } from '../repositories/notification_channel_repository.js';
import { NotificationRuleRepository } from '../repositories/notification_rule_repository.js';
import { RealmRepository } from '../repositories/realm_repository.js';
import { OrgRepository } from '../repositories/org_repository.js';
import { ApiError } from '../errors/api_error.js';
import { OrgMember } from '../models/index.js';
import type { NotificationRule } from '../models/notification_rule.model.js';
import type { Destination } from '../notifications/channel_config.js';
import type { NotificationRuleData } from '../schemas/notification_types.js';

import {
	REALM_MEMBERS_CHANNEL,
	REALM_MEMBERS_CHANNEL_NAME,
	realm_members_channel_id,
} from '../notifications/defaults.js';

const log = get_logger('svc.notification');

const channel_repo = new NotificationChannelRepository();
const rule_repo = new NotificationRuleRepository();
const realm_repo = new RealmRepository();
const org_repo = new OrgRepository();

/** Wire-compatible channel row (matches SDK NotificationChannelRecord). */
export type ChannelRecord = {
	id: string;
	/** Null for org-level channels. */
	realm_id: string | null;
	/** Owning org for org-level channels. */
	org_id?: string | null;
	/** Owning user — set for personal channels. */
	user_id?: string | null;
	name: string;
	/** Parsed destination list (built from channel_destinations rows). */
	destinations: Destination[];
	enabled: number;
	created_at: number;
	updated_at: number;
	/** Number of notification rules pointing at this channel. */
	rule_count?: number;
	/** Stable key of a channel CliqHub seeded (e.g. `org.email`), else null. */
	system_key: string | null;
	/** True when the channel can't be changed or removed. */
	locked: boolean;
	/** Why the channel is locked (null when it isn't). */
	lock_reason: string | null;
};

/** A rule row on the wire, with its lock state. */
function to_rule_data(r: NotificationRule): NotificationRuleData {
	return {
		id: r.id!,
		realm_id: r.realm_id,
		org_id: r.org_id ? String(r.org_id) : null,
		event: r.event,
		channel_id: r.channel_id,
		priority: r.priority,
		created_at: Number(r.created_at),
		updated_at: Number(r.updated_at),
		system_key: r.system_key ?? null,
		locked: Boolean(r.locked),
		lock_reason: r.lock_reason ?? null,
		enabled: r.enabled !== false,
	};
}

/** Order destinations are shown and indexed in: in-app first, then email, chat, hooks and refs. */
const DESTINATION_ORDER = ['cliqhub', 'email', 'slack', 'webhook', 'http', 'jira', 'channel_ref'];

/** Destination rows in a stable order (by type, then creation), the same for display and for `destination_index`. */
export function sort_destination_rows<T extends { type: string; created_at?: number | string | null; id?: string }>(rows: T[]): T[] {
	const rank = (t: string) => { const i = DESTINATION_ORDER.indexOf(t); return i === -1 ? DESTINATION_ORDER.length : i; };
	return [...rows].sort((a, b) => rank(a.type) - rank(b.type)
		|| Number(a.created_at ?? 0) - Number(b.created_at ?? 0)
		|| String(a.id ?? '').localeCompare(String(b.id ?? '')));
}

export class NotificationService {

	/** Convert a model row (with eager-loaded destinations_rows) to API shape. */
	private static to_channel_record(row: {
		id: string;
		realm_id: string | null;
		org_id?: string | null;
		user_id?: string | null;
		name: string;
		enabled: number;
		created_at: number;
		updated_at: number;
		system_key?: string | null;
		locked?: boolean;
		lock_reason?: string | null;
		destinations_rows?: Array<{ type: string; config: Record<string, unknown>; created_at?: number; id?: string }>;
	}): ChannelRecord {
		const dest_rows = sort_destination_rows(row.destinations_rows ?? []);
		const destinations = dest_rows.map((r) => ({
			type: r.type,
			...r.config,
		})) as Destination[];

		return {
			id: row.id,
			realm_id: row.realm_id ?? null,
			org_id: row.org_id ?? null,
			user_id: row.user_id ?? null,
			name: row.name,
			destinations,
			enabled: row.enabled,
			created_at: Number(row.created_at),
			updated_at: Number(row.updated_at),
			system_key: row.system_key ?? null,
			locked: Boolean(row.locked),
			lock_reason: row.lock_reason ?? null,
		};
	}

	/**
	 * Given a concrete event type, build the set of selectors that would
	 * match it in the rules table: the exact type, its family wildcard,
	 * and the global wildcard.
	 *
	 * Example: `phase.escalated` → `['phase.escalated', 'phase.*', '*']`
	 */
	private static build_matching_selectors(event: string): string[] {
		// Rules may match exact, family wildcard (phase.*), or global *.
		const selectors = [event];
		const dot = event.indexOf('.');
		if (dot > 0) {
			selectors.push(event.slice(0, dot + 1) + '*');
		}
		selectors.push('*');
		return selectors;
	}

	/**
	 * Reject `channel_ref` destination graphs that cycle back to `channel_name`.
	 */
	static async detect_channel_ref_cycles(channel_name: string, destinations: Destination[], realm_id: string | null): Promise<void> {
		log.debug('detect_channel_ref_cycles', { channel_name, realm_id });
		// Only channel_ref destinations can form a graph; others are leaves.
		const refs = destinations
			.filter((d): d is Destination & { type: 'channel_ref' } => d.type === 'channel_ref')
			.map((d) => d.name);
		if (refs.length === 0) return;

		// Seed visited with the channel being written so A→…→A is caught.
		const visited = new Set<string>([channel_name]);
		for (const ref of refs) {
			await NotificationService.walk_channel_ref(ref, [channel_name], visited, realm_id);
		}
	}

	private static async walk_channel_ref(ref_name: string, path: string[], visited: Set<string>, realm_id: string | null): Promise<void> {
		// Re-entering a name already on the path means a cycle.
		if (visited.has(ref_name)) {
			throw new ApiError('bad_request', `Channel reference cycle detected: ${[...path, ref_name].join(' → ')}`, 400);
		}
		visited.add(ref_name);

		// Missing targets are ignored — they fail at delivery time, not at save.
		const target = await NotificationService.find_channel_by_name(ref_name, realm_id ?? undefined);
		if (!target) return;

		let child_destinations: Destination[] = [];
		try {
			const raw = target.destinations;
			child_destinations = Array.isArray(raw) ? (raw as Destination[]) : [];
		} catch {
			return;
		}

		const child_refs = child_destinations
			.filter((d): d is Destination & { type: 'channel_ref' } => d.type === 'channel_ref')
			.map((d) => d.name);

		for (const child_ref of child_refs) {
			await NotificationService.walk_channel_ref(child_ref, [...path, ref_name], visited, realm_id);
		}
	}

	/** Throw conflict if `name` is already taken in the given realm/org scope, or crosses scopes within the same org. */
	private static async assert_channel_name_available(name: string, realm_id: string | null, org_id: string | null): Promise<void> {
		// 1. Same-scope uniqueness check (realm vs realm, org vs org).
		const same_scope_where: Record<string, unknown> = { name };
		if (realm_id) {
			same_scope_where.realm_id = realm_id;
		} else {
			same_scope_where.realm_id = { [Op.is]: null };
			if (org_id) same_scope_where.org_id = org_id;
		}
		const same_scope_clash = await channel_repo.find_one(same_scope_where as any);
		if (same_scope_clash) {
			let scope_label = 'in your global settings';
			if (same_scope_clash.realm_id) {
				const owner_realm = await realm_repo.find_by_id(same_scope_clash.realm_id);
				const realm_label = owner_realm?.name || owner_realm?.slug || same_scope_clash.realm_id;
				scope_label = `in realm "${realm_label}"`;
			}
			throw new ApiError(
				'conflict',
				`A channel named '${name}' already exists ${scope_label}. Choose a different name.`,
				409,
			);
		}

		// 2. Cross-scope check: org-level channel names are reserved across the entire org.
		if (realm_id) {
			// Creating a realm channel — check if the org already has an org-level channel with this name.
			const realm = await realm_repo.find_by_id(realm_id);
			if (realm?.org_id) {
				const org_clash = await channel_repo.find_one({
					name, org_id: realm.org_id, realm_id: { [Op.is]: null },
				} as any);
				if (org_clash) {
					const org = await org_repo.find_by_id(realm.org_id);
					const org_label = org?.display_name || org?.slug || realm.org_id;
					throw new ApiError(
						'conflict',
						`A channel named '${name}' already exists at the organization level in ${org_label}. Use the organization channel or choose a different name.`,
						409,
					);
				}
			}
		} else if (org_id) {
			// Creating an org-level channel — check if any realm in this org already has a channel with this name.
			const org_realms = await realm_repo.find_all({ org_id } as any, { attributes: ['id', 'name', 'slug'] });
			if (org_realms.length > 0) {
				const realm_ids = org_realms.map((r) => r.id);
				const realm_clash = await channel_repo.find_one({
					name, realm_id: { [Op.in]: realm_ids },
				} as any);
				if (realm_clash) {
					const owner = org_realms.find((r) => r.id === realm_clash.realm_id);
					const realm_label = owner?.name || owner?.slug || realm_clash.realm_id;
					throw new ApiError(
						'conflict',
						`A channel named '${name}' already exists in realm "${realm_label}". Choose a different name or remove the realm channel first.`,
						409,
					);
				}
			}
		}
	}

	// ── Channels ───────────────────────────────────────────────────

	static async list_channels(filters?: {
		realm_id?: string;
		/** When true, only org-level channels (realm_id IS NULL). */
		account?: boolean;
		/** Org context — filters org-level channels to this org. */
		org_id?: string;
		query?: string;
		/** Only this user's personal channel. Without it, personal channels are never listed (they're private). */
		mine_user_id?: string;
	}): Promise<ChannelRecord[]> {
		log.debug('list_channels', { realm_id: filters?.realm_id, org_id: filters?.org_id });
		// Build scope filter: account (realm null) vs a concrete realm.
		const where: Record<string, unknown> = filters?.mine_user_id
			? { user_id: filters.mine_user_id }
			: { user_id: { [Op.is]: null } };
		if (filters?.account || filters?.org_id) {
			where.realm_id = { [Op.is]: null };
			if (filters?.org_id) {
				where.org_id = filters.org_id;
			}
		}
		if (filters?.realm_id) where.realm_id = filters.realm_id;
		const query = filters?.query?.trim();
		if (query) {
			const pattern = `%${query.replace(/[%_]/g, '\\$&')}%`;
			where.name = { [Op.iLike]: pattern };
		}

		const { ChannelDestination } = await import('../models/index.js');
		const rows = await channel_repo.find_all(where as any, {
			order: [['name', 'ASC']],
			include: [{ model: ChannelDestination, as: 'destinations_rows' }],
		});
		const records = rows.map((row) => NotificationService.to_channel_record(row));

		// Attach rule_count so the UI can show "used by N rules" without N+1.
		const channel_ids = records.map((r) => r.id);
		if (channel_ids.length > 0) {
			const rule_rows = await rule_repo.find_all(
				{ channel_id: { [Op.in]: channel_ids } } as any,
				{ attributes: ['channel_id'] },
			);
			const counts = new Map<string, number>();
			for (const r of rule_rows) {
				const cid = (r as unknown as { channel_id: string }).channel_id;
				counts.set(cid, (counts.get(cid) ?? 0) + 1);
			}
			for (const rec of records) {
				rec.rule_count = counts.get(rec.id) ?? 0;
			}
		}

		return records;
	}

	static async get_channel(id: string): Promise<ChannelRecord> {
		log.debug('get_channel', { id });
		// Include destinations so the DTO has a populated destinations JSON string.
		const { ChannelDestination } = await import('../models/index.js');
		const ch = await channel_repo.find_by_id(id);
		if (!ch) throw new ApiError('not_found', `notification channel '${id}' not found`, 404);
		const ch_with_dest = await channel_repo.find_one({ id } as any, {
			include: [{ model: ChannelDestination, as: 'destinations_rows' }],
		});
		if (!ch_with_dest) throw new ApiError('not_found', `notification channel '${id}' not found`, 404);
		return NotificationService.to_channel_record(ch_with_dest);
	}

	/** Raw model row (unmasked config) for delivery. */
	static async get_channel_record(id: string) {
		log.debug('get_channel_record', { id });
		// Delivery path needs the Sequelize row (secret column), not the wire DTO.
		const ch = await channel_repo.find_by_id(id);
		if (!ch) throw new ApiError('not_found', `notification channel '${id}' not found`, 404);
		return ch;
	}

	static async find_channel_by_name(name: string, realm_id?: string): Promise<ChannelRecord | null> {
		log.debug('find_channel_by_name', { name, realm_id });
		// Name lookup is scope-aware: realm channels vs account (realm_id null).
		const where: Record<string, unknown> = { name };
		if (realm_id) {
			where.realm_id = realm_id;
		}
		if (!realm_id) {
			where.realm_id = { [Op.is]: null };
		}
		const { ChannelDestination } = await import('../models/index.js');
		const ch = await channel_repo.find_one(where as any, {
			include: [{ model: ChannelDestination, as: 'destinations_rows' }],
		});
		if (!ch) return null;
		return NotificationService.to_channel_record(ch);
	}

	/**
	 * What a name reaches from a realm: the channel of that name (the realm's own, else its org's) and the
	 * personal channel of the person with that username when they're a member of the realm — both, when both
	 * exist. Empty when neither does. Used for names a run or a gate gives (notify channels, hug channels).
	 */
	static async find_realm_usable_channels(name: string, realm_id: string): Promise<ChannelRecord[]> {
		const { Realm, ChannelDestination } = await import('../models/index.js');
		const include = [{ model: ChannelDestination, as: 'destinations_rows' }];
		const realm = await Realm.findByPk(realm_id, { attributes: ['org_id'], raw: true });
		const found: ChannelRecord[] = [];
		// The channel of that name: the realm's, else the org's.
		const own = await NotificationService.find_channel_by_name(name, realm_id);
		if (own) found.push(own);
		else if (realm?.org_id) {
			const ch = await channel_repo.find_one({ name, org_id: realm.org_id, realm_id: { [Op.is]: null }, user_id: { [Op.is]: null } } as any, { include });
			if (ch) found.push(NotificationService.to_channel_record(ch));
		}
		// And the person of that name, when they're in the realm — both get it.
		const { find_member_personal_channel } = await import('./per_user_channel.service.js');
		const person = await find_member_personal_channel(name, { org_id: realm?.org_id ?? null, realm_id });
		if (person) {
			const row = await channel_repo.find_one({ id: person.id } as any, { include });
			if (row) found.push(NotificationService.to_channel_record(row));
		}
		return found;
	}

	/**
	 * An email destination with `account: true` sends to the channel owner's account email, so only
	 * a personal channel (one with an owner) can have it.
	 *
	 * @throws ApiError 400 when `owner_id` is null and a destination uses `account: true`
	 */
	/** `members: true` email is CliqHub's own (built-in channels); people can't set it. */
	static assert_no_members_email(destinations: unknown[]): void {
		const uses_members = destinations.some((d) => (d as { type?: unknown }).type === 'email' && (d as { members?: unknown }).members === true);
		if (uses_members) {
			throw new ApiError('invalid_params', 'Invalid destinations: members: true is only for built-in channels', 422, { field: 'destinations' });
		}
	}

	static assert_account_email_owner(destinations: unknown[], owner_id: string | null): void {
		if (owner_id) return;
		const uses_account = destinations.some((d) => (d as { type?: unknown; account?: unknown }).type === 'email' && (d as { account?: unknown }).account === true);
		if (uses_account) {
			throw new ApiError('bad_request', "Invalid destinations: account: true is only for a person's own channel; give an address", 400);
		}
	}

	static async create_channel(data: {
		realm_id?: string | null;
		/** Org owning this channel (for org-level channels where realm_id is null). */
		org_id?: string | null;
		name: string;
		destinations: unknown[];
		enabled?: boolean;
	}): Promise<ChannelRecord> {
		log.debug('create_channel', { name: data.name, realm_id: data.realm_id });
		const realm_id = data.realm_id?.trim() || null;
		const org_id = realm_id ? null : (data.org_id ?? null);
		const name = data.name.trim();
		if (!name) throw new ApiError('bad_request', 'name is required', 400);
		if (!data.destinations || data.destinations.length === 0) {
			throw new ApiError('bad_request', 'At least one destination is required', 400);
		}
		// Channels made here have no owner, so there is no account email to send to.
		NotificationService.assert_account_email_owner(data.destinations, null);
		NotificationService.assert_no_members_email(data.destinations);

		if (realm_id) {
			const realm = await realm_repo.find_by_id(realm_id);
			if (!realm) throw new ApiError('not_found', `realm '${realm_id}' not found`, 404);
		}

		await NotificationService.assert_channel_name_available(name, realm_id, org_id);

		const now = Date.now();
		const channel_id = randomUUID();
		const { ChannelDestination } = await import('../models/index.js');

		/** Webhook secrets live on the channel row's dedicated `secret`
		 *  column, not inside the destination config JSON. This keeps
		 *  masking straightforward, lets rotate_channel_secret work
		 *  independently of the destinations, and ensures a secret is
		 *  never accidentally exposed via a destinations-JSON dump. */
		let channel_secret: string | null = null;
		for (const dest of data.destinations) {
			const d = dest as Record<string, unknown>;
			if (d.type === 'webhook' && typeof d.secret === 'string' && d.secret.length > 0) {
				channel_secret = d.secret;
				break;
			}
		}

		const row = await channel_repo.create_one({
			id: channel_id,
			realm_id,
			org_id,
			name,
			enabled: data.enabled === false ? 0 : 1,
			secret: channel_secret,
			created_at: now,
			updated_at: now,
		} as any);

		/** Write destination rows. Strip `secret` from webhook configs —
		 *  it belongs on the channel column, not in the destination JSON. */
		for (const dest of data.destinations) {
			const d = dest as Record<string, unknown>;
			const dest_type = String(d.type || 'cliqhub');
			const { type: _t, secret: _s, ...config } = d;
			await ChannelDestination.create({
				id: randomUUID(),
				channel_id,
				type: dest_type,
				config,
				created_at: now,
			});
		}

		/** Re-fetch with eager-loaded destinations for the response. */
		const { ChannelDestination: CD_create } = await import('../models/index.js');
		const created = await channel_repo.find_one({ id: channel_id } as any, {
			include: [{ model: CD_create, as: 'destinations_rows' }],
		});
		log.info('channel_created', { channel_id, realm_id });
		return NotificationService.to_channel_record(created!);
	}

	/**
	 * Updates a channel's name, destinations or enabled flag.
	 *
	 * @throws ApiError 404 unknown channel; 409 `locked` for a locked (system) channel
	 */
	static async update_channel(data: {
		id: string;
		name?: string;
		destinations?: unknown[];
		enabled?: boolean;
	}): Promise<ChannelRecord> {
		log.debug('update_channel', { id: data.id });
		const existing = await NotificationService.get_channel_record(data.id);
		if (existing.locked) throw ApiError.locked(existing.system_key ?? '', `Channel '${existing.name}' is a system channel and can't be changed`);
		const updates: Record<string, unknown> = { updated_at: Date.now() };

		if (data.name !== undefined) {
			const name = data.name.trim();
			if (!name) throw new ApiError('bad_request', 'name is required', 400);
			if (name !== existing.name) {
				await NotificationService.assert_channel_name_available(name, existing.realm_id, existing.org_id ?? null);
			}
			updates.name = name;
		}

		if (data.destinations !== undefined) {
			// A personal channel always keeps in-app, so its person can't miss everything.
			if (existing.user_id && !data.destinations.some((d) => (d as { type?: unknown })?.type === 'cliqhub')) {
				throw new ApiError('invalid_params', 'Your personal channel always keeps in-app (CliqHub) — add or remove the others', 422);
			}
			NotificationService.assert_account_email_owner(data.destinations, existing.user_id ?? null);
			NotificationService.assert_no_members_email(data.destinations);
			/** Replace all destination rows. */
			const { ChannelDestination } = await import('../models/index.js');
			await ChannelDestination.destroy({ where: { channel_id: data.id } });
			const now = Date.now();
			for (const dest of data.destinations) {
				const d = dest as Record<string, unknown>;
				const dest_type = String(d.type || 'cliqhub');
				const { type: _t, ...config } = d;
				await ChannelDestination.create({
					id: randomUUID(),
					channel_id: data.id,
					type: dest_type,
					config,
					created_at: now,
				});
			}
		}

		if (data.enabled !== undefined) {
			updates.enabled = data.enabled ? 1 : 0;
		}

		await existing.update(updates);
		log.info('channel_updated', { id: data.id });

		/** Re-fetch with eager-loaded destinations. */
		const { ChannelDestination: CD2 } = await import('../models/index.js');
		const refreshed = await channel_repo.find_one({ id: data.id } as any, {
			include: [{ model: CD2, as: 'destinations_rows' }],
		});
		return NotificationService.to_channel_record(refreshed!);
	}

	/**
	 * Deletes a channel (destination rows cascade).
	 *
	 * @returns false when the channel did not exist.
	 * @throws ApiError 409 `locked` for a locked (system) channel
	 */
	static async remove_channel(id: string): Promise<boolean> {
		log.debug('remove_channel', { id });
		const channel = await channel_repo.find_by_id(id);
		if (channel?.locked) throw ApiError.locked(channel.system_key ?? '', `Channel '${channel.name}' is a system channel and can't be removed`);
		const deleted = await channel_repo.delete_where({ id } as any);
		if (deleted > 0) log.info('channel_removed', { id });
		return deleted > 0;
	}

	/**
	 * Generate a new HMAC signing secret for a webhook channel and
	 * persist it to the dedicated `secret` column. Returns the raw
	 * secret exactly once — the caller must record it (JIRA plugin
	 * stores it in Forge Storage; humans copy from the settings UI).
	 * Subsequent reads via get_channel show only the '***' mask.
	 *
	 * Restricted to webhook provider — slack/email/cliqhub don't sign
	 * outbound bodies so rotation is a category error there.
	 *
	 * Format: `whsec_<48 hex chars>` (~192 bits entropy). The `whsec_`
	 * prefix matches Stripe/Svix/GitHub-style secrets and lets grep
	 * catch accidentally committed values.
	 */
	static async rotate_channel_secret(id: string): Promise<{ secret: string }> {
		log.debug('rotate_channel_secret', { id });
		const existing = await NotificationService.get_channel_record(id);

		/** Only channels with a webhook destination support HMAC signing. */
		const { ChannelDestination } = await import('../models/index.js');
		const webhook_dest = await ChannelDestination.findOne({
			where: { channel_id: id, type: 'webhook' },
		});		if (!webhook_dest) {
			throw new ApiError(
				'bad_request',
				`Channel '${id}' has no webhook destination — only webhook channels support HMAC secret rotation.`,
				400,
			);
		}

		const secret = `whsec_${randomBytes(24).toString('hex')}`;
		await existing.update({ secret, updated_at: Date.now() });
		log.info('channel_secret_rotated', { id });
		return { secret };
	}

	/**
	 * Send a synthetic test notification through a channel's destinations.
	 * If `destination_index` is provided, only that single destination is tested.
	 */
	static async test_channel(id: string, destination_index?: number): Promise<{ delivered: number; errors: string[] }> {
		log.debug('test_channel', { id, destination_index });
		const ch = await NotificationService.get_channel_record(id);

		/** Read destinations from the normalized table. */
		const { ChannelDestination } = await import('../models/index.js');
		const dest_rows = sort_destination_rows(await ChannelDestination.findAll({ where: { channel_id: id } }));
		let destinations: Array<Record<string, unknown>> = dest_rows.map(
			(r) => ({ type: r.type, ...r.config }),
		);

		/** Narrow to a single destination if requested. */
		if (destination_index != null) {
			if (destination_index < 0 || destination_index >= destinations.length) {
				return { delivered: 0, errors: [`Destination index ${destination_index} out of range`] };
			}
			destinations = [destinations[destination_index]];
		}

		const { get_deliverer } = await import('../notifications/deliverers/index.js');
		const { is_channel_provider } = await import('../notifications/types.js');
		const { destination_to_config } = await import('../notifications/fan_out.service.js');

		const test_payload = {
			event: 'notification.test',
			title: 'Channel test',
			message: `Test notification for channel "${ch.name}"`,
			severity: 'info',
		};

		let delivered = 0;
		const errors: string[] = [];

		for (const dest of destinations) {
			const dest_type = String(dest.type ?? '');
			if (dest_type === 'channel_ref') continue;
			if (dest_type === 'cliqhub') {
				delivered += 1;
				continue;
			}

			const provider = dest_type === 'http' ? 'webhook' : dest_type;
			if (!is_channel_provider(provider)) {
				errors.push(`Unsupported destination type: ${dest_type}`);
				continue;
			}

			try {
				const deliverer = get_deliverer(provider as Parameters<typeof get_deliverer>[0]);
				// The same config the fan-out sends (an email `address` becomes `to`), and the channel so
				// an `account: true` email finds its owner.
				await deliverer.deliver(destination_to_config(dest as unknown as Destination), test_payload, { channel_id: id });
				delivered += 1;
			} catch (err) {
				errors.push(err instanceof Error ? err.message : String(err));
			}
		}

		return { delivered, errors };
	}

	static async find_enabled_channels(ids: string[]) {
		log.debug('find_enabled_channels', {});
		if (ids.length === 0) return [];
		// Used by the UI when refreshing a known id set (enabled-only).
		const { ChannelDestination } = await import('../models/index.js');
		return channel_repo.find_all(
			{ id: { [Op.in]: ids }, enabled: 1 } as any,
			{ include: [{ model: ChannelDestination, as: 'destinations_rows' }] },
		);
	}

	// ── Rules ─────────────────────────────────────────────────────

	/**
	 * The channels an event goes to: the org's rules **and** the realm's own (PLAN-notifications-v2 B1).
	 * They're separate and both apply — a realm's rule adds to the org's for that realm, never replaces
	 * it; a switched-off rule only stops itself. Selectors: exact, family wildcard (`run.*`) or `*`.
	 * The org is the realm's org (given or looked up), so another org's rules never apply.
	 *
	 * @returns Channel ids, each once.
	 */
	static async resolve_rules(opts: {
		event: string;
		realm_id?: string | null;
		/** Org context for global-tier rule resolution. */
		org_id?: string;
	}): Promise<string[]> {
		log.debug('resolve_rules', { event: opts.event, realm_id: opts.realm_id });
		const { event, realm_id } = opts;

		const event_selectors = NotificationService.build_matching_selectors(event);
		const channels: string[] = [];

		if (realm_id) {
			const realm_rules = await rule_repo.find_all({
				realm_id,
				team_slug: { [Op.is]: null },
				event: { [Op.in]: event_selectors },
				enabled: true,
			} as any);
			channels.push(...realm_rules.map((r) => r.channel_id));
		}

		// The org's rules — always the realm's org; with neither an org nor a realm there's nothing to match.
		const org_id = opts.org_id ?? (realm_id ? (await realm_repo.find_by_id(realm_id))?.org_id ?? undefined : undefined);
		if (org_id) {
			const org_rules = await rule_repo.find_all({
				realm_id: { [Op.is]: null },
				team_slug: { [Op.is]: null },
				org_id,
				event: { [Op.in]: event_selectors },
				enabled: true,
			} as any);
			channels.push(...org_rules.map((r) => r.channel_id));
		}

		return [...new Set(channels)];
	}

	/**
	 * Org-tier rules matching an org event (exact type, family wildcard or `*`).
	 * Unlike {@link resolve_rules} every match is returned, so every rule an
	 * owner added fires (the built-in invite/account messages are not rules).
	 */
	static async resolve_org_rules(opts: { event: string; org_id: string }): Promise<Array<{ id: string; channel_id: string }>> {
		log.debug('resolve_org_rules', { event: opts.event, org_id: opts.org_id });
		const rows = await rule_repo.find_all({
			org_id: opts.org_id,
			realm_id: { [Op.is]: null },
			team_slug: { [Op.is]: null },
			event: { [Op.in]: NotificationService.build_matching_selectors(opts.event) },
			enabled: true,
		}, { order: [['priority', 'DESC'], ['created_at', 'ASC']] });
		return rows.map((r) => ({ id: String(r.id), channel_id: r.channel_id }));
	}

	/** List all rules visible at a given tier (for the UI). */
	static async list_rules(opts: {
		realm_id?: string | null;
		/** Org context — filters org-level rules (realm_id IS NULL) to this org. */
		org_id?: string;
	} = {}): Promise<NotificationRuleData[]> {
		log.debug('list_rules', { realm_id: opts?.realm_id });
		const where: Record<string, unknown> = {};
		where.team_slug = { [Op.is]: null };
		if (opts.realm_id) {
			where.realm_id = opts.realm_id;
		} else {
			where.realm_id = { [Op.is]: null };
			if (opts.org_id) {
				where.org_id = opts.org_id;
			}
		}
		const rows = await rule_repo.find_all(where as any, { order: [['event', 'ASC'], ['priority', 'DESC']] });
		return rows.map(to_rule_data);
	}

	/** The rules in play in a realm: the org's and the realm's own — both apply. */
	static async list_effective_rules(realm_id: string, org_id?: string): Promise<Array<NotificationRuleData & { tier: 'global' | 'realm' }>> {
		log.debug('list_effective_rules', { realm_id });
		const realm = org_id ? null : await realm_repo.find_by_id(realm_id);
		const resolved_org_id = org_id ?? realm?.org_id ?? undefined;
		const global_rules = await NotificationService.list_rules({ org_id: resolved_org_id });
		const realm_rules = await NotificationService.list_rules({ realm_id });

		const effective: Array<NotificationRuleData & { tier: 'global' | 'realm' }> = [];
		for (const r of global_rules) {
			effective.push({ ...r, tier: 'global' });
		}
		for (const r of realm_rules) {
			effective.push({ ...r, tier: 'realm' });
		}

		effective.sort((a, b) => a.event.localeCompare(b.event));
		return effective;
	}

	/**
	 * Creates or updates the rule for (tier, event, channel) and its priority.
	 * A rule sends to its channel's destinations.
	 *
	 * @throws ApiError 400 missing event / channel; 404 unknown channel; 403 channel outside the rule's realm or org; 409
	 *   `locked` when the existing rule is locked
	 */
	static async set_rule(data: {
		realm_id?: string | null;
		/** Org owning this rule (for org-level rules where realm_id is null). */
		org_id?: string | null;
		event: string;
		channel_id: string;
		priority?: number;
		/** On or off; a new rule is on unless this says otherwise, an existing one keeps its state when omitted. */
		enabled?: boolean;
	}): Promise<NotificationRuleData> {
		log.debug('set_rule', { event: data.event, channel_id: data.channel_id, realm_id: data.realm_id });
		const realm_id = data.realm_id?.trim() || null;
		const org_id = realm_id ? null : (data.org_id ?? null);
		const event = data.event.trim();
		const channel_id = data.channel_id.trim();
		if (!event || !channel_id) throw new ApiError('bad_request', 'event and channel_id are required', 400);

		// Validate that the channel belongs to the same org as this rule.
		const channel = await channel_repo.find_by_id(channel_id);
		if (!channel) throw new ApiError('not_found', `notification channel '${channel_id}' not found`, 404);

		if (realm_id) {
			// Realm rule: channel must be in this realm, or be an org-level channel from the realm's org.
			if (channel.realm_id !== null && channel.realm_id !== realm_id) {
				throw new ApiError('forbidden', `Channel '${channel_id}' does not belong to this realm or its organization`, 403);
			}
			if (channel.realm_id === null) {
				// Org-level channel — verify it belongs to the realm's org.
				const realm = await realm_repo.find_by_id(realm_id);
				const channel_org = channel.org_id ? String(channel.org_id) : null;
				if (!realm || channel_org !== realm.org_id) {
					throw new ApiError('forbidden', `Channel '${channel_id}' does not belong to this organization`, 403);
				}
			}
		} else if (org_id) {
			// Org rule: channel must be an org-level channel for this org.
			if (channel.realm_id !== null) {
				throw new ApiError('forbidden', `Channel '${channel_id}' is a realm channel and cannot be used for an org-level rule`, 403);
			}
			const channel_org = channel.org_id ? String(channel.org_id) : null;
			if (channel_org !== org_id) {
				throw new ApiError('forbidden', `Channel '${channel_id}' does not belong to this organization`, 403);
			}
		}


		const now = Date.now();
		const existing = await rule_repo.find_one({
			realm_id: realm_id ? realm_id : { [Op.is]: null },
			team_slug: { [Op.is]: null },
			event,
			channel_id,
		} as any);

		if (existing) {
			if (existing.locked) throw ApiError.locked(existing.system_key ?? '', `The rule for ${existing.event} is a system rule and can't be changed`);
			await existing.update({
				priority: data.priority ?? existing.priority ?? 0,
				...(data.enabled === undefined ? {} : { enabled: data.enabled }),
				updated_at: now,
			});
			return to_rule_data(existing);
		}

		const row = await rule_repo.create_one({
			realm_id,
			org_id,
			team_slug: null,
			event,
			channel_id,
			priority: data.priority ?? 0,
			recipients: null,
			enabled: data.enabled ?? true,
			created_at: now,
			updated_at: now,
		} as any);
		log.info('rule_created', { rule_id: row.id!, realm_id, event, channel_id });
		return to_rule_data(row);
	}

	static async get_rule(id: string): Promise<NotificationRuleData | null> {
		log.debug('get_rule', { id });
		const rule = await rule_repo.find_by_id(id);
		if (!rule) return null;
		return to_rule_data(rule);
	}

	/**
	 * Deletes a rule; a missing id returns false (idempotent).
	 *
	 * @throws ApiError 409 `locked` for a locked (system) rule
	 */
	static async remove_rule(id: string): Promise<boolean> {
		log.debug('remove_rule', { id });
		const rule = await rule_repo.find_by_id(id);
		if (rule?.locked) throw ApiError.locked(rule.system_key ?? '', `The rule for ${rule.event} is a system rule and can't be removed`);
		const deleted = await rule_repo.delete_where({ id } as any);
		if (deleted > 0) log.info('rule_removed', { id });
		return deleted > 0;
	}

	/**
	 * The realm's "All realm members" channel (built in, locked): everyone in the realm, each the way they
	 * chose. It starts with no rules (the org's default sends failed runs to its realm's members); an existing
	 * one (also the legacy `cliqhub` realm channel) is brought in line — name, on, built in, locked, its
	 * destinations — and its rules are left as people set them.
	 */
	static async ensure_realm_members_channel(realm_id: string): Promise<ChannelRecord> {
		log.debug('ensure_realm_members_channel', { realm_id });
		const trimmed = realm_id.trim();
		if (!trimmed) throw new ApiError('bad_request', 'realm_id is required', 400);

		const realm = await realm_repo.find_by_id(trimmed);
		if (!realm) throw new ApiError('not_found', `realm '${trimmed}' not found`, 404);

		const channel_id = realm_members_channel_id(trimmed);
		let row = await channel_repo.find_by_id(channel_id)
			?? await channel_repo.find_one({ realm_id: trimmed, name: { [Op.in]: [REALM_MEMBERS_CHANNEL_NAME, 'cliqhub'] } } as any);
		if (row) {
			const builtin = { enabled: 1, name: REALM_MEMBERS_CHANNEL_NAME, system_key: REALM_MEMBERS_CHANNEL.system_key, locked: true, lock_reason: REALM_MEMBERS_CHANNEL.lock_reason };
			const off = row.enabled !== 1 || row.name !== builtin.name || row.system_key !== builtin.system_key || !row.locked || row.lock_reason !== builtin.lock_reason;
			if (off) await row.update({ ...builtin, updated_at: Date.now() } as any);
			await NotificationService._ensure_destinations(row.id, REALM_MEMBERS_CHANNEL.destinations);
			return NotificationService.to_channel_record(row);
		}

		const now = Date.now();
		row = await channel_repo.create_one({
			id: channel_id,
			realm_id: trimmed,
			name: REALM_MEMBERS_CHANNEL_NAME,
			enabled: 1,
			system_key: REALM_MEMBERS_CHANNEL.system_key,
			locked: true,
			lock_reason: REALM_MEMBERS_CHANNEL.lock_reason,
			created_at: now,
			updated_at: now,
		} as any);
		await NotificationService._ensure_destinations(channel_id, REALM_MEMBERS_CHANNEL.destinations);
		log.info('realm_members_channel_created', { realm_id: trimmed, channel_id });
		return NotificationService.to_channel_record(row);
	}

	/** Adds the built-in destinations a channel is missing (one row per type; existing rows are kept). */
	private static async _ensure_destinations(channel_id: string, destinations: readonly { type: string; config: Record<string, unknown> }[]): Promise<void> {
		const { ChannelDestination } = await import('../models/index.js');
		for (const d of destinations) {
			await ChannelDestination.findOrCreate({
				where: { channel_id, type: d.type },
				defaults: { id: randomUUID(), channel_id, type: d.type, config: d.config, created_at: Date.now() },
			});
		}
	}

}
