/**
 * Dashboard Hub resource — DASH-ORG hard-cut.
 *
 * POST /internal/dashboard/realms | summary: body `org_id` required.
 * Never invent org from X-Org-Id / current_org_id.
 */

import { Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { z } from 'zod';
import { Team, Run, InAppNotification, RealmMember, Review, Realm } from '../models/index.js';
import { DaemonService } from '../services/daemon.service.js';
import { RealmService } from '../services/realm.service.js';
import { RunService } from '../services/run.service.js';
import { ReviewPendingService } from '../services/review_pending.service.js';
import { ApiError } from '../lib/api_error.js';
import type { AuthContext } from '../types/vo.js';

const dashboard_org_schema = z.object({
	org_id: z.string().uuid().describe(
		'Organization UUID. Required for dashboard rollups — never invent from X-Org-Id.',
	),
});

function as_ms(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

function map_run_row(
	r: {
		run_id: string;
		run_name?: string | null;
		state: string;
		team_id?: string | null;
		team_label?: string | null;
		daemon_id?: string | null;
		started_at?: number | null;
		completed_at?: number | null;
	},
	realms_by_daemon: Map<string, Array<{ id: string; slug: string }>>,
) {
	const realms = r.daemon_id ? (realms_by_daemon.get(r.daemon_id) ?? []) : [];
	const realm = realms[0] ?? null;
	return {
		run_id: r.run_id,
		run_name: r.run_name,
		state: r.state,
		team_id: r.team_id,
		team_label: r.team_label ?? null,
		daemon_id: r.daemon_id ?? null,
		realm_id: realm?.id ?? null,
		realm_slug: realm?.slug ?? null,
		started_at: as_ms(r.started_at),
		completed_at: as_ms(r.completed_at),
	};
}

export class DashboardController {
	/**
	 * Bearer must be allowed to act on `org_id`.
	 * PAT/session: org_id ∈ auth.org_ids. Daemon token: realm.org_id === org_id.
	 * Site hub admin may act on any org_id.
	 */
	private static async assert_org_authorized(auth: AuthContext | undefined, org_id: string): Promise<void> {
		// No credential context — refuse rather than invent tenancy.
		if (!auth) {
			throw ApiError.unauthorized('authentication required');
		}

		// Site admin may target any org.
		if (auth.user?.role === 'admin') return;

		// Daemon tokens are realm-bound; tenancy is the realm's org.
		if (auth.auth_via === 'daemon_token') {
			if (!auth.realm_id) {
				throw ApiError.forbidden('daemon token has no realm binding');
			}
			const realm = await Realm.findByPk(auth.realm_id);
			if (!realm || realm.org_id !== org_id) {
				throw ApiError.forbidden('org_id does not match daemon realm organization');
			}
			return;
		}

		// PAT / session: live membership list from auth middleware.
		if (!auth.org_ids.includes(org_id)) {
			throw ApiError.forbidden('not a member of the requested organization');
		}
	}

	private static auth_from(req: Request): AuthContext | undefined {
		return (req as Request & { auth?: AuthContext }).auth;
	}

	/**
	 * Realm-centric dashboard: per-realm daemon/run/review/notification rollup,
	 * sorted by most recent activity. Drives the new "fleet pulse" home view.
	 * Body `org_id` required (DASH-ORG hard-cut).
	 */
	static async realms_summary(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = req.user?.user_id;
			if (!user_id) {
				res.status(401).json({ ok: false, error: 'Unauthorized' });
				return;
			}

			// Zod SoT — org_id required; never invent from X-Org-Id.
			const body = dashboard_org_schema.parse(req.body ?? {});
			await DashboardController.assert_org_authorized(DashboardController.auth_from(req), body.org_id);
			const org_id = body.org_id;
			const { realms: member_realms } = await RealmService.list_for_user(user_id, { org_id });
			if (member_realms.length === 0) {
				res.json({
					ok: true,
					realms: [],
					totals: { realms_active: 0, daemons_online: 0, runs_active: 0 },
				});
				return;
			}

			const realm_ids = member_realms.map((r) => r.id);
			const one_hour_ago = Date.now() - 60 * 60 * 1000;
			const user_daemon_ids = await RealmService.list_daemon_ids_for_user(user_id);

			const [daemon_members, all_daemons, active_runs, pending_reviews, recent_notifs] = await Promise.all([
				RealmMember.findAll({
					where: { realm_id: { [Op.in]: realm_ids }, member_type: 'daemon' },
					attributes: ['realm_id', 'member_id'],
				}),
				DaemonService.list(user_id, { org_id }),
				user_daemon_ids.length > 0
					? Run.findAll({
						where: {
							daemon_id: { [Op.in]: user_daemon_ids },
							state: { [Op.in]: ['running', 'awaiting_input'] },
						},
						attributes: ['run_id', 'daemon_id', 'state', 'started_at'],
					})
					: Promise.resolve([]),
				Review.findAll({
					where: {
						realm_id: { [Op.in]: realm_ids },
						status: { [Op.in]: ['pending', 'decided'] },
					},
					attributes: ['realm_id'],
				}),
				InAppNotification.findAll({
					where: {
						realm_id: { [Op.in]: realm_ids },
						created_at: { [Op.gte]: one_hour_ago },
					},
					attributes: ['realm_id', 'created_at'],
				}),
			]);

			const daemon_status_map = new Map<string, { status: string; last_heartbeat: number | null }>();
			for (const d of all_daemons.daemons) {
				daemon_status_map.set(d.id, { status: d.status, last_heartbeat: d.last_heartbeat });
			}

			const daemon_to_realm = new Map<string, string>();
			const realm_daemon_ids = new Map<string, string[]>();
			for (const m of daemon_members) {
				daemon_to_realm.set(m.member_id, m.realm_id);
				const list = realm_daemon_ids.get(m.realm_id) ?? [];
				list.push(m.member_id);
				realm_daemon_ids.set(m.realm_id, list);
			}

			let total_online = 0;
			let total_active_runs = 0;

			const realms = member_realms.map((realm) => {
				const d_ids = realm_daemon_ids.get(realm.id) ?? [];
				let online = 0;
				let stale = 0;
				let offline = 0;
				let latest_heartbeat = 0;

				for (const did of d_ids) {
					const info = daemon_status_map.get(did);
					if (!info) { offline++; continue; }
					if (info.status === 'online') online++;
					else if (info.status === 'stale') stale++;
					else offline++;
					if (info.last_heartbeat && info.last_heartbeat > latest_heartbeat) {
						latest_heartbeat = info.last_heartbeat;
					}
				}
				total_online += online;

				const realm_active_runs = active_runs.filter((r) => {
					const r_realm = daemon_to_realm.get(r.daemon_id ?? '');
					return r_realm === realm.id;
				});
				const active_count = realm_active_runs.length;
				const awaiting_count = realm_active_runs.filter((r) => r.state === 'awaiting_input').length;
				total_active_runs += active_count;

				const latest_run_start = realm_active_runs.reduce(
					(max, r) => Math.max(max, as_ms(r.started_at) ?? 0), 0,
				);

				const review_count = pending_reviews.filter((r) => r.realm_id === realm.id).length;
				const notif_count = recent_notifs.filter((n) => n.realm_id === realm.id).length;
				const latest_notif = recent_notifs
					.filter((n) => n.realm_id === realm.id)
					.reduce((max, n) => Math.max(max, Number(n.created_at) || 0), 0);

				const last_activity_at = Math.max(latest_heartbeat, latest_run_start, latest_notif) || realm.created_at;

				return {
					id: realm.id,
					slug: realm.slug,
					org_slug: realm.org_slug ?? null,
					name: realm.name,
					last_activity_at,
					daemons: { online, stale, offline, total: d_ids.length },
					runs: { active: active_count, awaiting_input: awaiting_count },
					pending_reviews: review_count,
					recent_notifications: notif_count,
				};
			});

			realms.sort((a, b) => b.last_activity_at - a.last_activity_at);
			const realms_active = realms.filter((r) => r.daemons.online > 0).length;

			res.json({
				ok: true,
				realms,
				totals: {
					realms_active,
					daemons_online: total_online,
					runs_active: total_active_runs,
				},
			});
		} catch (err) {
			next(err);
		}
	}

	/**
	 * Product home summary.
	 * Daemons + runs are scoped to realms the caller belongs to
	 * (same visibility as POST /v1/daemons/get and POST /v1/runs/get).
	 * Body `org_id` required (DASH-ORG hard-cut).
	 */
	static async summary(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = req.user?.user_id;
			if (!user_id) {
				res.status(401).json({ ok: false, error: 'Unauthorized' });
				return;
			}

			// Zod SoT — org_id required; never invent from X-Org-Id.
			const body = dashboard_org_schema.parse(req.body ?? {});
			await DashboardController.assert_org_authorized(DashboardController.auth_from(req), body.org_id);
			const org_id = body.org_id;

			const day_ago = Date.now() - 24 * 60 * 60 * 1000;
			const daemon_ids = await RealmService.list_daemon_ids_for_user_in_org(user_id, org_id);
			const run_where_base = daemon_ids.length > 0
				? { daemon_id: { [Op.in]: daemon_ids } }
				: null;

			const [
				team_count,
				daemons,
				recent,
				live_running,
				live_awaiting,
				active_run_count,
				awaiting_input_count,
				failed_24h_count,
				completed_24h_count,
				run_count,
				pending_reviews,
			] = await Promise.all([
				Team.count(),
				DaemonService.list(user_id, { org_id }),
				RunService.list_recent(10, undefined, { user_id, org_id }),
				RunService.list_recent(8, undefined, { user_id, state: 'running', org_id }),
				RunService.list_recent(8, undefined, { user_id, state: 'awaiting_input', org_id }),
				run_where_base
					? Run.count({
						where: {
							...run_where_base,
							state: { [Op.in]: ['running', 'awaiting_input'] },
						},
					})
					: Promise.resolve(0),
				run_where_base
					? Run.count({
						where: { ...run_where_base, state: 'awaiting_input' },
					})
					: Promise.resolve(0),
				run_where_base
					? Run.count({
						where: {
							...run_where_base,
							state: { [Op.in]: ['failed', 'crashed'] },
							started_at: { [Op.gte]: day_ago },
						},
					})
					: Promise.resolve(0),
				run_where_base
					? Run.count({
						where: {
							...run_where_base,
							state: 'completed',
							started_at: { [Op.gte]: day_ago },
						},
					})
					: Promise.resolve(0),
				run_where_base
					? Run.count({ where: run_where_base })
					: Promise.resolve(0),
				ReviewPendingService.list_for_user({ user_id, org_id, limit: 5, offset: 0 }),
			]);

			const live_enriched = [...live_awaiting.runs, ...live_running.runs]
				.sort((a, b) => (as_ms(b.started_at) ?? 0) - (as_ms(a.started_at) ?? 0))
				.slice(0, 8);

			const realm_daemon_ids = [...new Set([
				...recent.runs.map((r: { daemon_id?: string | null }) => r.daemon_id),
				...live_enriched.map((r: { daemon_id?: string | null }) => r.daemon_id),
			].filter((id): id is string => Boolean(id)))];
			const realms_by_daemon = await RealmService.list_realms_by_daemon_ids(realm_daemon_ids);

			const { realms: member_realms } = await RealmService.list_for_user(user_id, { org_id });
			const daemons_online = daemons.daemons.filter((d) => d.status === 'online').length;
			const daemons_stale = daemons.daemons.filter((d) => d.status === 'stale').length;
			const daemons_offline = daemons.daemons.filter((d) => d.status === 'offline').length;
			const pending_review_count = pending_reviews.reviews.filter((r) => r.status === 'pending').length;

			const mapped_recent = recent.runs.map((r) => map_run_row(r, realms_by_daemon));
			const mapped_live = live_enriched.map((r) => map_run_row(r, realms_by_daemon));

			const suggested_teams: Array<{
				team_id: string | null;
				label: string;
				scope: string;
				name: string;
				last_seen_at: number | null;
				last_daemon_id: string | null;
			}> = [];
			const seen_teams = new Set<string>();
			for (const r of [...mapped_live, ...mapped_recent]) {
				const label = r.team_label?.trim();
				if (!label) continue;
				const match = label.match(/^@([^/]+)\/(.+)$/);
				if (!match) continue;
				const key = label.toLowerCase();
				if (seen_teams.has(key)) continue;
				seen_teams.add(key);
				suggested_teams.push({
					team_id: r.team_id ?? null,
					label,
					scope: match[1],
					name: match[2],
					last_seen_at: r.started_at,
					last_daemon_id: r.daemon_id ?? null,
				});
				if (suggested_teams.length >= 6) break;
			}

			const oldest_awaiting = mapped_live
				.filter((r) => r.state === 'awaiting_input' && r.started_at)
				.sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0))[0];

			const last_completed = mapped_recent.find((r) => r.state === 'completed') ?? null;

			res.json({
				ok: true,
				scope: {
					/** Home aggregates across every realm the caller is a member of. */
					mode: 'all_member_realms',
					daemon_count: daemon_ids.length,
				},
				counts: {
					teams: team_count,
					runs: run_count,
					active_runs: active_run_count,
					awaiting_input: awaiting_input_count,
					failed_24h: failed_24h_count,
					completed_24h: completed_24h_count,
					daemons_online,
					daemons_stale,
					daemons_offline,
					daemons_total: daemons.total,
					pending_reviews: pending_review_count,
					realms: member_realms.length,
				},
				attention: {
					awaiting_input: awaiting_input_count,
					failed_24h: failed_24h_count,
					daemons_offline,
					daemons_stale,
					pending_reviews: pending_review_count,
					oldest_awaiting_started_at: oldest_awaiting?.started_at ?? null,
					last_completed_at: last_completed?.completed_at ?? last_completed?.started_at ?? null,
					last_completed_label: last_completed?.team_label
						?? last_completed?.run_name
						?? null,
				},
				realms: member_realms.map((r) => ({
					id: r.id,
					slug: r.slug,
					name: r.name,
				})),
				suggested_teams,
				live_runs: mapped_live,
				pending_reviews: pending_reviews.reviews.slice(0, 5),
				recent_runs: mapped_recent,
			});
		} catch (err) {
			next(err);
		}
	}
}
