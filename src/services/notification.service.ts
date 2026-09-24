import { randomBytes, randomUUID } from 'node:crypto';
import { Op } from 'sequelize';

import {
	NotificationChannel,
	NotificationRule,
	Realm,
} from '../models/index.js';
import { ApiError } from '../lib/api_error.js';
import type { Destination } from '../notifications/channel_config.js';

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
	/** Serialized destination array (built from channel_destinations rows). */
	destinations: string;
	enabled: number;
	created_at: number;
	updated_at: number;
	/** Number of notification rules pointing at this channel. */
	rule_count?: number;
};

export class NotificationService {

	/** Convert a model row (with eager-loaded destinations_rows) to API shape. */
	private static to_channel_record(row: {
		id: string;
		realm_id: string | null;
		name: string;
		enabled: number;
		created_at: number;
		updated_at: number;
	}): ChannelRecord {
		// Destinations live in a child table; serialize to the wire JSON string clients expect.
		const dest_rows = (row as any).destinations_rows;
		const destinations_str = Array.isArray(dest_rows)
			? JSON.stringify(
				dest_rows.map((r: { type: string; config: Record<string, unknown> }) => ({
					type: r.type,
					...r.config,
				})),
			)
			: '[]';

		return {
			id: row.id,
			realm_id: row.realm_id ?? null,
			org_id: (row as any).org_id ?? null,
			user_id: (row as any).user_id ?? null,
			name: row.name,
			destinations: destinations_str,
			enabled: row.enabled,
			created_at: Number(row.created_at),
			updated_at: Number(row.updated_at),
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
			throw ApiError.bad_request(`Channel reference cycle detected: ${[...path, ref_name].join(' → ')}`);
		}
		visited.add(ref_name);

		// Missing targets are ignored — they fail at delivery time, not at save.
		const target = await NotificationService.find_channel_by_name(ref_name, realm_id ?? undefined);
		if (!target) return;

		let child_destinations: Destination[] = [];
		try {
			child_destinations = JSON.parse(target.destinations ?? '[]') as Destination[];
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

	/** Throw conflict if `name` is already taken in the given realm/org scope. */
	private static async assert_channel_name_available(name: string, realm_id: string | null, org_id: string | null): Promise<void> {
		// Names are unique per realm, or per org among account (realm_id null) channels.
		const clash_where: Record<string, unknown> = { name };
		if (realm_id) {
			clash_where.realm_id = realm_id;
		}
		if (!realm_id) {
			clash_where.realm_id = { [Op.is]: null };
			if (org_id) clash_where.org_id = org_id;
		}

		const clash = await NotificationChannel.findOne({ where: clash_where });
		if (!clash) return;

		let scope_label = 'in your global settings';
		if (clash.realm_id) {
			const owner_realm = await Realm.findByPk(clash.realm_id, { attributes: ['slug', 'name'] });
			const realm_label = owner_realm?.name || owner_realm?.slug || clash.realm_id;
			scope_label = `in realm "${realm_label}"`;
		}
		throw ApiError.conflict(
			`A channel named '${name}' already exists ${scope_label}. Choose a different name.`,
		);
	}

	// ── Channels ───────────────────────────────────────────────────

	static async list_channels(filters?: {
		realm_id?: string;
		/** When true, only org-level channels (realm_id IS NULL). */
		account?: boolean;
		/** Org context — filters org-level channels to this org. */
		org_id?: string;
		query?: string;
	}): Promise<ChannelRecord[]> {
		// Build scope filter: account (realm null) vs a concrete realm.
		const where: Record<string, unknown> = {};
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
		const rows = await NotificationChannel.findAll({
			where,
			order: [['name', 'ASC']],
			include: [{ model: ChannelDestination, as: 'destinations_rows' }],
		});
		const records = rows.map((row) => NotificationService.to_channel_record(row));

		// Attach rule_count so the UI can show "used by N rules" without N+1.
		const channel_ids = records.map((r) => r.id);
		if (channel_ids.length > 0) {
			const rule_rows = await NotificationRule.findAll({
				where: { channel_id: { [Op.in]: channel_ids } },
				attributes: ['channel_id'],
			});
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
		// Include destinations so the DTO has a populated destinations JSON string.
		const { ChannelDestination } = await import('../models/index.js');
		const ch = await NotificationChannel.findByPk(id, {
			include: [{ model: ChannelDestination, as: 'destinations_rows' }],
		});
		if (!ch) throw ApiError.not_found(`notification channel '${id}' not found`);
		return NotificationService.to_channel_record(ch);
	}

	/** Raw model row (unmasked config) for delivery. */
	static async get_channel_record(id: string) {
		// Delivery path needs the Sequelize row (secret column), not the wire DTO.
		const ch = await NotificationChannel.findByPk(id);
		if (!ch) throw ApiError.not_found(`notification channel '${id}' not found`);
		return ch;
	}

	static async find_channel_by_name(name: string, realm_id?: string): Promise<ChannelRecord | null> {
		// Name lookup is scope-aware: realm channels vs account (realm_id null).
		const where: Record<string, unknown> = { name };
		if (realm_id) {
			where.realm_id = realm_id;
		}
		if (!realm_id) {
			where.realm_id = { [Op.is]: null };
		}
		const { ChannelDestination } = await import('../models/index.js');
		const ch = await NotificationChannel.findOne({
			where,
			include: [{ model: ChannelDestination, as: 'destinations_rows' }],
		});
		if (!ch) return null;
		return NotificationService.to_channel_record(ch);
	}

	static async create_channel(data: {
		realm_id?: string | null;
		/** Org owning this channel (for org-level channels where realm_id is null). */
		org_id?: string | null;
		name: string;
		destinations: unknown[];
		enabled?: boolean;
	}): Promise<ChannelRecord> {
		const realm_id = data.realm_id?.trim() || null;
		const org_id = realm_id ? null : (data.org_id ?? null);
		const name = data.name.trim();
		if (!name) throw ApiError.bad_request('name is required');
		if (!data.destinations || data.destinations.length === 0) {
			throw ApiError.bad_request('At least one destination is required');
		}

		if (realm_id) {
			const realm = await Realm.findByPk(realm_id);
			if (!realm) throw ApiError.not_found(`realm '${realm_id}' not found`);
		}

		/** Org-scoped name uniqueness for account channels; realm-scoped for realm channels. */
		const scope_filter: Record<string, unknown> = { name };
		if (realm_id) {
			scope_filter.realm_id = realm_id;
		}
		if (!realm_id) {
			scope_filter.realm_id = { [Op.is]: null };
			if (org_id) scope_filter.org_id = org_id;
		}
		const existing = await NotificationChannel.findOne({ where: scope_filter });
		if (existing) {
			const scope_label = realm_id
				? `in realm "${(await Realm.findByPk(realm_id, { attributes: ['slug', 'name'] }))?.name ?? realm_id}"`
				: 'in your global settings';
			throw ApiError.conflict(
				`A channel named '${name}' already exists ${scope_label}. Choose a different name.`,
			);
		}

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

		const row = await NotificationChannel.create({
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
		const created = await NotificationChannel.findByPk(channel_id, {
			include: [{ model: ChannelDestination, as: 'destinations_rows' }],
		});
		return NotificationService.to_channel_record(created!);
	}

	static async update_channel(data: {
		id: string;
		name?: string;
		destinations?: unknown[];
		enabled?: boolean;
	}): Promise<ChannelRecord> {
		const existing = await NotificationService.get_channel_record(data.id);
		const updates: Record<string, unknown> = { updated_at: Date.now() };

		if (data.name !== undefined) {
			const name = data.name.trim();
			if (!name) throw ApiError.bad_request('name is required');
			if (name !== existing.name) {
				await NotificationService.assert_channel_name_available(name, existing.realm_id, existing.org_id ?? null);
			}
			updates.name = name;
		}

		if (data.destinations !== undefined) {
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

		/** Re-fetch with eager-loaded destinations. */
		const { ChannelDestination } = await import('../models/index.js');
		const refreshed = await NotificationChannel.findByPk(data.id, {
			include: [{ model: ChannelDestination, as: 'destinations_rows' }],
		});
		return NotificationService.to_channel_record(refreshed!);
	}

	static async remove_channel(id: string): Promise<boolean> {
		// Hard delete; destination rows cascade via FK / destroy hooks elsewhere.
		const deleted = await NotificationChannel.destroy({ where: { id } });
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
		const existing = await NotificationService.get_channel_record(id);

		/** Only channels with a webhook destination support HMAC signing. */
		const { ChannelDestination } = await import('../models/index.js');
		const webhook_dest = await ChannelDestination.findOne({
			where: { channel_id: id, type: 'webhook' },
		});
		if (!webhook_dest) {
			throw ApiError.bad_request(
				`Channel '${id}' has no webhook destination — only webhook channels support HMAC secret rotation.`,
			);
		}

		const secret = `whsec_${randomBytes(24).toString('hex')}`;
		await existing.update({ secret, updated_at: Date.now() });
		return { secret };
	}

	/**
	 * Send a synthetic test notification through a channel's destinations.
	 * Returns counts of successful deliveries and any error messages.
	 */
	/**
	 * Send a synthetic test notification through a channel's destinations.
	 * If `destination_index` is provided, only that single destination is tested.
	 */
	static async test_channel(id: string, destination_index?: number): Promise<{ delivered: number; errors: string[] }> {
		const ch = await NotificationService.get_channel_record(id);

		/** Read destinations from the normalized table. */
		const { ChannelDestination } = await import('../models/index.js');
		const dest_rows = await ChannelDestination.findAll({ where: { channel_id: id } });
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
				await deliverer.deliver(dest as Record<string, unknown>, test_payload);
				delivered += 1;
			} catch (err) {
				errors.push(err instanceof Error ? err.message : String(err));
			}
		}

		return { delivered, errors };
	}

	static async find_enabled_channels(ids: string[]) {
		if (ids.length === 0) return [];
		// Used by the UI when refreshing a known id set (enabled-only).
		const { ChannelDestination } = await import('../models/index.js');
		return NotificationChannel.findAll({
			where: { id: { [Op.in]: ids }, enabled: 1 },
			include: [{ model: ChannelDestination, as: 'destinations_rows' }],
		});
	}

	// ── Rules ─────────────────────────────────────────────────────

	/**
	 * Three-tier rule resolution with replace semantics.
	 *
	 * For a given event, realm, and team: the most specific tier wins.
	 * Wildcard selectors (`run.*`, `custom.*`, `*`) are expanded to
	 * match concrete event types.
	 *
	 * Returns channel IDs that should receive the notification.
	 */
	static async resolve_rules(opts: {
		event: string;
		realm_id?: string | null;
		team_slug?: string | null;
		/** Org context for global-tier rule resolution. */
		org_id?: string;
	}): Promise<string[]> {
		const { event, realm_id, team_slug } = opts;

		const event_selectors = NotificationService.build_matching_selectors(event);

		if (realm_id && team_slug) {
			const team_rules = await NotificationRule.findAll({
				where: {
					realm_id,
					team_slug,
					event: { [Op.in]: event_selectors },
				},
			});
			if (team_rules.length > 0) {
				return [...new Set(team_rules.map((r) => r.channel_id))];
			}
		}

		if (realm_id) {
			const realm_rules = await NotificationRule.findAll({
				where: {
					realm_id,
					team_slug: { [Op.is]: null },
					event: { [Op.in]: event_selectors },
				},
			});
			if (realm_rules.length > 0) {
				return [...new Set(realm_rules.map((r) => r.channel_id))];
			}
		}

		const global_where: Record<string, unknown> = {
			realm_id: { [Op.is]: null },
			team_slug: { [Op.is]: null },
			event: { [Op.in]: event_selectors },
		};
		if (opts.org_id) {
			global_where.org_id = opts.org_id;
		}
		const global_rules = await NotificationRule.findAll({
			where: global_where,
		});
		if (global_rules.length > 0) {
			return [...new Set(global_rules.map((r) => r.channel_id))];
		}

		return [];
	}

	/** List all rules visible at a given tier (for the UI). */
	static async list_rules(opts: {
		realm_id?: string | null;
		team_slug?: string | null;
		/** Org context — filters org-level rules (realm_id IS NULL) to this org. */
		org_id?: string;
	} = {}): Promise<Array<{ id: string; realm_id: string | null; team_slug: string | null; event: string; channel_id: string; priority: number; created_at: number; updated_at: number }>> {
		const where: Record<string, unknown> = {};
		if (opts.realm_id) {
			where.realm_id = opts.realm_id;
		}
		if (opts.team_slug) {
			where.team_slug = opts.team_slug;
		}
		if (!opts.realm_id && !opts.team_slug) {
			where.realm_id = { [Op.is]: null };
			where.team_slug = { [Op.is]: null };
			if (opts.org_id) {
				where.org_id = opts.org_id;
			}
		}
		const rows = await NotificationRule.findAll({ where, order: [['event', 'ASC'], ['priority', 'DESC']] });
		return rows.map((r) => ({
			id: r.id!,
			realm_id: r.realm_id,
			team_slug: r.team_slug,
			event: r.event,
			channel_id: r.channel_id,
			priority: r.priority,
			created_at: Number(r.created_at),
			updated_at: Number(r.updated_at),
		}));
	}

	/** List effective rules for a realm (org-level + realm overrides). */
	static async list_effective_rules(realm_id: string, org_id?: string): Promise<Array<{ id: string; realm_id: string | null; team_slug: string | null; event: string; channel_id: string; priority: number; created_at: number; updated_at: number; tier: 'global' | 'realm' }>> {
		const global_rules = await NotificationService.list_rules({ org_id });
		const realm_rules = await NotificationService.list_rules({ realm_id });

		const realm_events = new Set(realm_rules.map((r) => r.event));

		const effective: Array<ReturnType<typeof NotificationService.list_effective_rules> extends Promise<(infer T)[]> ? T : never> = [];
		for (const r of global_rules) {
			if (!realm_events.has(r.event)) {
				effective.push({ ...r, tier: 'global' });
			}
		}
		for (const r of realm_rules) {
			effective.push({ ...r, tier: 'realm' });
		}

		effective.sort((a, b) => a.event.localeCompare(b.event));
		return effective;
	}

	static async set_rule(data: {
		realm_id?: string | null;
		/** Org owning this rule (for org-level rules where realm_id is null). */
		org_id?: string | null;
		team_slug?: string | null;
		event: string;
		channel_id: string;
		priority?: number;
	}): Promise<{ id: string; realm_id: string | null; team_slug: string | null; event: string; channel_id: string; priority: number; created_at: number; updated_at: number }> {
		const realm_id = data.realm_id?.trim() || null;
		const org_id = realm_id ? null : (data.org_id ?? null);
		const team_slug = data.team_slug?.trim() || null;
		const event = data.event.trim();
		const channel_id = data.channel_id.trim();
		if (!event || !channel_id) throw ApiError.bad_request('event and channel_id are required');

		const now = Date.now();
		const existing = await NotificationRule.findOne({
			where: {
				realm_id: realm_id ? realm_id : { [Op.is]: null },
				team_slug: team_slug ? team_slug : { [Op.is]: null },
				event,
				channel_id,
			},
		});

		if (existing) {
			await existing.update({ priority: data.priority ?? 0, updated_at: now });
			return {
				id: existing.id!,
				realm_id: existing.realm_id,
				team_slug: existing.team_slug,
				event: existing.event,
				channel_id: existing.channel_id,
				priority: existing.priority,
				created_at: Number(existing.created_at),
				updated_at: Number(existing.updated_at),
			};
		}

		const row = await NotificationRule.create({
			realm_id,
			org_id,
			team_slug,
			event,
			channel_id,
			priority: data.priority ?? 0,
			created_at: now,
			updated_at: now,
		} as any);
		return {
			id: row.id!,
			realm_id: row.realm_id,
			team_slug: row.team_slug,
			event: row.event,
			channel_id: row.channel_id,
			priority: row.priority,
			created_at: Number(row.created_at),
			updated_at: Number(row.updated_at),
		};
	}

	static async remove_rule(id: string): Promise<boolean> {
		// Rules are hard-deleted; missing id returns false (idempotent).
		const deleted = await NotificationRule.destroy({ where: { id } });
		return deleted > 0;
	}

	/** Per-realm in-app channel (`cliqhub`). Ensures enabled. */
	static async ensure_realm_cliqhub_channel(realm_id: string): Promise<ChannelRecord> {
		const trimmed = realm_id.trim();
		if (!trimmed) throw ApiError.bad_request('realm_id is required');

		const realm = await Realm.findByPk(trimmed);
		if (!realm) throw ApiError.not_found(`realm '${trimmed}' not found`);

		const channel_id = `cliqhub-${trimmed}`;
		let row = await NotificationChannel.findByPk(channel_id);
		if (!row) {
			row = await NotificationChannel.findOne({
				where: { realm_id: trimmed, name: 'cliqhub' },
			});
		}
		if (!row) {
			const now = Date.now();
			row = await NotificationChannel.create({
				id: channel_id,
				realm_id: trimmed,
				name: 'cliqhub',
				enabled: 1,
				created_at: now,
				updated_at: now,
			});
			/** Create the default in-app destination row. */
			const { ChannelDestination } = await import('../models/index.js');
			await ChannelDestination.findOrCreate({
				where: { channel_id, type: 'cliqhub' },
				defaults: {
					id: `${channel_id}:cliqhub:${now}`,
					channel_id,
					type: 'cliqhub',
					config: {},
					created_at: now,
				},
			});
			return NotificationService.to_channel_record(row);
		}
		if (row.enabled !== 1) {
			await row.update({ enabled: 1, updated_at: Date.now() });
		}
		return NotificationService.to_channel_record(row);
	}

	/**
	 * Per-realm all-users notify channel (`realm:all_users`).
	 * Hub-only — daemon never resolves or sends this id (Yamazaki H3.2).
	 */
	static async ensure_realm_all_users_channel(realm_id: string): Promise<ChannelRecord> {
		const trimmed = realm_id.trim();
		if (!trimmed) throw ApiError.bad_request('realm_id is required');

		const realm = await Realm.findByPk(trimmed);
		if (!realm) throw ApiError.not_found(`realm '${trimmed}' not found`);

		// Stable synthetic id so re-ensure is idempotent across restarts.
		const channel_id = `all_users-${trimmed}`;
		let row = await NotificationChannel.findByPk(channel_id);
		// Legacy rows may use the name without the synthetic id — fall back to name lookup.
		if (!row) {
			row = await NotificationChannel.findOne({
				where: { realm_id: trimmed, name: 'realm:all_users' },
			});
		}
		if (!row) {
			const now = Date.now();
			row = await NotificationChannel.create({
				id: channel_id,
				realm_id: trimmed,
				name: 'realm:all_users',
				enabled: 1,
				created_at: now,
				updated_at: now,
			});
			// Default destination is in-app (cliqhub) — fan-out to all realm members.
			const { ChannelDestination } = await import('../models/index.js');
			await ChannelDestination.findOrCreate({
				where: { channel_id, type: 'cliqhub' },
				defaults: {
					id: `${channel_id}:cliqhub:${now}`,
					channel_id,
					type: 'cliqhub',
					config: {},
					created_at: now,
				},
			});
			return NotificationService.to_channel_record(row);
		}
		// Re-enable if an operator disabled the system channel.
		if (row.enabled !== 1) {
			await row.update({ enabled: 1, updated_at: Date.now() });
		}
		return NotificationService.to_channel_record(row);
	}

}
