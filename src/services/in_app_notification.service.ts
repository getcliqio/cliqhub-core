import { Op } from 'sequelize';

import { InAppNotification, RealmMember } from '../models/index.js';
import type { NotificationPayload } from '../notifications/types.js';
import { ApiError } from '../lib/api_error.js';
import { randomUUID } from 'node:crypto';

const KNOWN_TOP_LEVEL = new Set([
	'event',
	'title',
	'message',
	'realm_id',
	'team_slug',
	'run_id',
	'phase_name',
	'severity',
	'reason',
	'outcome',
	'run_name',
	'daemon_name',
	'daemon_id',
]);

export interface InAppNotificationRecord {
	id: string;
	event: string;
	title: string | null;
	message: string | null;
	realm_id: string | null;
	/** Resolved realm slug for display — null when realm was deleted. */
	realm_slug: string | null;
	/** Target user for per-user notifications. NULL = realm-wide. */
	user_id: string | null;
	team: string | null;
	run_id: string | null;
	phase: string | null;
	severity: string | null;
	payload: Record<string, unknown>;
	created_at: number;
}

function extra_payload(payload: NotificationPayload): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (KNOWN_TOP_LEVEL.has(key)) continue;
		out[key] = value;
	}
	if (payload.reason != null) out.reason = payload.reason;
	if (payload.outcome != null) out.outcome = payload.outcome;
	if (payload.run_name != null) out.run_name = payload.run_name;
	if (payload.daemon_name != null) out.daemon_name = payload.daemon_name;
	if (payload.daemon_id != null) out.daemon_id = payload.daemon_id;
	return out;
}

function to_record(row: {
	id: string;
	event: string;
	title: string | null;
	message: string | null;
	realm_id: string | null;
	user_id: string | null;
	team: string | null;
	run_id: string | null;
	phase: string | null;
	severity: string | null;
	payload_json: string;
	created_at: number;
}): InAppNotificationRecord {
	let payload: Record<string, unknown> = {};
	try {
		payload = JSON.parse(row.payload_json) as Record<string, unknown>;
	} catch {
		payload = {};
	}
	return {
		id: row.id,
		event: row.event,
		title: row.title,
		message: row.message,
		realm_id: row.realm_id,
		realm_slug: null,
		user_id: row.user_id ?? null,
		team: row.team,
		run_id: row.run_id,
		phase: row.phase,
		severity: row.severity,
		payload,
		created_at: Number(row.created_at),
	};
}

/**
 * Bulk-resolve realm_id → slug for a page of notifications.
 * Single query, no N+1. Deleted realms stay null.
 */
async function _enrich_realm_slugs(records: InAppNotificationRecord[]): Promise<void> {
	const ids = [...new Set(
		records.map((r) => r.realm_id).filter(Boolean) as string[],
	)];
	if (ids.length === 0) return;

	try {
		const { Realm } = await import('../models/index.js');
		const realms = await Realm.findAll({
			where: { id: { [Op.in]: ids } },
			attributes: ['id', 'slug'],
		});
		const slug_map = new Map<string, string>();
		for (const r of realms) {
			slug_map.set(r.id, r.slug);
		}
		for (const rec of records) {
			if (rec.realm_id) {
				rec.realm_slug = slug_map.get(rec.realm_id) ?? null;
			}
		}
	} catch { /* best-effort — slugs stay null */ }
}

/**
 * Persist / list in-app notifications (cliqhub channel deliverer).
 * Not an events inbox over cliq.events.
 */
export class InAppNotificationService {
	static async create_from_payload(
		payload: NotificationPayload,
		user_id?: string | null,
	): Promise<InAppNotificationRecord> {
		const event = String(payload.event ?? '').trim();
		if (!event) throw new Error('notification payload.event is required');

		const id = randomUUID();
		const created_at = Date.now();
		/** Extract review_id from payload for HUG event indexing. */
		const review_id = typeof payload.review_id === 'string'
			? payload.review_id.trim() || null
			: null;

		// Resolve org_id from realm for org-scoped inbox queries.
		let org_id: string | null = null;
		const realm_id_val = payload.realm_id?.trim() || null;
		if (realm_id_val) {
			try {
				const { Realm } = await import('../models/index.js');
				const realm = await Realm.findByPk(realm_id_val, { attributes: ['org_id'] });
				if (realm?.org_id) org_id = realm.org_id;
			} catch { /* best-effort */ }
		}

		const row = await InAppNotification.create({
			id,
			event,
			title: payload.title?.trim() || null,
			message: payload.message?.trim() || null,
			realm_id: realm_id_val,
			org_id,
			user_id: user_id ?? null,
			team: payload.team_slug?.trim() || null,
			run_id: payload.run_id?.trim() || null,
			phase: payload.phase_name?.trim() || null,
			severity: payload.severity?.trim() || null,
			review_id,
			payload_json: JSON.stringify(extra_payload(payload)),
			created_at,
		});
		return to_record(row);
	}

	/**
	 * Visibility: realm rows for memberships + account-scoped rows (realm_id null)
	 * for any authenticated user.
	 */
	static async list_for_user(opts: {
		user_id: string;
		realm_id?: string;
		/** Org boundary — only show notifications for this org. */
		org_id?: string;
		/** Multi-select realm filter (facet). Both id and slug are accepted;
		 * slugs are resolved to ids caller-side. Intersected with membership. */
		realms?: string[];
		types?: string[];
		severities?: string[];
		teams?: string[];
		run_id?: string;
		phases?: string[];
		q?: string;
		since_ms?: number;
		until_ms?: number;
		/** When true, only return events for runs the user initiated. */
		initiated_by_me?: boolean;
		limit?: number;
		offset?: number;
	}): Promise<{ notifications: InAppNotificationRecord[]; total: number }> {
		const user_id = opts.user_id.trim();
		if (!user_id) throw ApiError.unauthorized('Authentication required');

		const limit_raw = opts.limit ?? 50;
		const limit = Math.min(Math.max(1, limit_raw), 100);
		const offset = Math.max(0, opts.offset ?? 0);

		const memberships = await RealmMember.findAll({
			where: { member_type: 'user', member_id: user_id },
			attributes: ['realm_id'],
		});
		const member_realm_ids = memberships.map((m) => m.realm_id);

		// Accept either legacy single `realm_id` or the newer multi-select
		// `realms` array (facet). Intersect with membership so unauthorized
		// realms silently drop out rather than surfacing an error.
		const filter_realm = opts.realm_id?.trim();
		const filter_realms_raw = (opts.realms ?? []).map((r) => r.trim()).filter(Boolean);
		const requested = filter_realm
			? [filter_realm, ...filter_realms_raw]
			: filter_realms_raw;
		const allowed = requested.filter((id) => member_realm_ids.includes(id));
		if (requested.length > 0 && allowed.length === 0) {
			return { notifications: [], total: 0 };
		}

		// Visibility: realm-scoped rows for memberships, account-scoped
		// rows (realm_id null), and user-targeted rows (user_id match).
		const realm_clause = allowed.length > 0
			? {
				[Op.or]: [
					{ realm_id: { [Op.in]: allowed } },
					{ user_id },
				],
			}
			: {
				[Op.or]: [
					{ realm_id: { [Op.is]: null } },
					{ user_id },
					...(member_realm_ids.length > 0
						? [{ realm_id: { [Op.in]: member_realm_ids } }]
						: []),
				],
			};

		const and_parts: Record<string, unknown>[] = [{ ...realm_clause }];

		// Org boundary: restrict to the active org when provided.
		if (opts.org_id) and_parts.push({ org_id: opts.org_id });

		const types = (opts.types ?? []).map((t) => t.trim()).filter(Boolean);
		if (types.length > 0) and_parts.push({ event: { [Op.in]: types } });

		const severities = (opts.severities ?? []).map((s) => s.trim()).filter(Boolean);
		if (severities.length > 0) and_parts.push({ severity: { [Op.in]: severities } });

		const teams = (opts.teams ?? []).map((t) => t.trim()).filter(Boolean);
		if (teams.length > 0) and_parts.push({ team: { [Op.in]: teams } });

		const phases = (opts.phases ?? []).map((p) => p.trim()).filter(Boolean);
		if (phases.length > 0) and_parts.push({ phase: { [Op.in]: phases } });

		if (opts.run_id?.trim()) and_parts.push({ run_id: opts.run_id.trim() });

		if (opts.initiated_by_me) {
			/**
			 * Filter to events for runs the user started. Uses a subquery
			 * against cliq.events where actor_id matches and type = 'run.started'.
			 */
			const { literal: lit } = await import('sequelize');
			and_parts.push({
				run_id: {
					[Op.in]: lit(
						`(SELECT DISTINCT "run_id" FROM cliq."events" WHERE "actor_id" = '${user_id.replace(/'/g, "''")}' AND "type" = 'run.started' AND "run_id" IS NOT NULL)`,
					),
				},
			});
		}

		if (opts.since_ms != null || opts.until_ms != null) {
			const created: Record<string | symbol, number> = {};
			if (opts.since_ms != null) created[Op.gte] = opts.since_ms;
			if (opts.until_ms != null) created[Op.lte] = opts.until_ms;
			and_parts.push({ created_at: created });
		}

		const q = opts.q?.trim();
		if (q) {
			and_parts.push({
				[Op.or]: [
					{ title: { [Op.iLike]: `%${q}%` } },
					{ message: { [Op.iLike]: `%${q}%` } },
					{ event: { [Op.iLike]: `%${q}%` } },
					{ team: { [Op.iLike]: `%${q}%` } },
					{ run_id: { [Op.iLike]: `%${q}%` } },
				],
			});
		}

		const where = and_parts.length === 1
			? and_parts[0]
			: { [Op.and]: and_parts };

		const total = await InAppNotification.count({ where });
		const rows = await InAppNotification.findAll({
			where,
			order: [['created_at', 'DESC']],
			limit,
			offset,
		});
		const notifications = rows.map(to_record);
		await _enrich_realm_slugs(notifications);
		return { notifications, total };
	}
}
