import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';

import { ApiError } from '../lib/api_error.js';
import { EventSubmitService } from '../events/index.js';
import { Review } from '../models/review.model.js';
import { ReviewNotification } from '../models/review_notification.model.js';
import { RealmMember, Run, RunEvent } from '../models/index.js';
import { User } from '../db/models/index.js';
import { ensure_per_user_channel } from './per_user_channel.service.js';
import { load_env } from '../config/env.js';
import {
	load_artifacts_for_run,
	load_realm_info_map,
	load_run_info_map,
	resolve_team,
	type ReviewArtifactInfo,
} from './review_enrichment.js';
import { NotificationService } from './notification.service.js';
import {
	resolve_reviewer_groups,
	type ReviewerGroup,
	type ResolvedGroup,
} from './reviewer_resolution.service.js';
import { get_logger } from '../lib/log.js';

/**
 * When a review was created for `phase.input_required` but the payload
 * lacks `inputs_schema` / `fields`, fall back to the catalog run event
 * `phase.input_required` and synthesize a schema from `fields` or
 * legacy `missing_inputs`. Catalog only — no underscored lookups.
 */
async function _backfill_inputs_schema(
	payload: Record<string, unknown>,
	run_id: string,
): Promise<Record<string, unknown>> {
	const event = payload['event'];
	if (event !== 'phase.input_required' && payload['mode'] !== 'input_pause') {
		return payload;
	}
	const existing = payload['inputs_schema'];
	if (Array.isArray(existing) && existing.length > 0) return payload;
	const fields = payload['fields'];
	if (Array.isArray(fields) && fields.length > 0) {
		const schema = fields
			.filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string')
			.map((f) => ({
				name: String(f.name),
				label: typeof f.label === 'string' ? f.label : String(f.name),
				type: typeof f.type === 'string' ? f.type : 'text',
				required: f.required !== false,
				help: typeof f.help === 'string' ? f.help : '',
			}));
		if (schema.length > 0) return { ...payload, inputs_schema: schema };
	}

	const phase = typeof payload['phase'] === 'string' ? payload['phase'] : '';
	if (!phase || !run_id) return payload;

	try {
		const rows = await RunEvent.findAll({
			where: { run_id, event_type: 'phase.input_required', phase },
			order: [['id', 'DESC']],
			limit: 1,
		});
		if (rows.length === 0) return payload;
		const raw = rows[0].get('payload_json') as string | null;
		if (!raw) return payload;
		const parsed = JSON.parse(raw) as {
			fields?: Array<{ name?: string; help?: string; type?: string; required?: boolean; label?: string }>;
			missing_inputs?: Array<{ name?: string; description?: string }>;
		};
		if (Array.isArray(parsed.fields) && parsed.fields.length > 0) {
			const schema = parsed.fields
				.filter((m): m is { name: string; help?: string; type?: string; required?: boolean; label?: string } =>
					typeof m?.name === 'string' && m.name.length > 0)
				.map((m) => ({
					name: m.name,
					label: m.label ?? m.name,
					type: m.type ?? 'text',
					required: m.required !== false,
					help: m.help || `Required input for phase '${phase}'`,
				}));
			if (schema.length > 0) return { ...payload, inputs_schema: schema };
		}
		const missing = Array.isArray(parsed.missing_inputs) ? parsed.missing_inputs : [];
		if (missing.length === 0) return payload;

		const schema = missing
			.filter((m): m is { name: string; description?: string } => typeof m?.name === 'string' && m.name.length > 0)
			.map((m) => ({
				name: m.name,
				label: m.name,
				type: 'text',
				required: true,
				help: m.description || `Required input for phase '${phase}'`,
			}));
		if (schema.length === 0) return payload;

		return { ...payload, inputs_schema: schema };
	} catch {
		return payload;
	}
}

export interface CreateReviewInput {
	run_id: string;
	daemon_id: string;
	realm_id: string;
	payload: Record<string, unknown>;
	route_targets?: string[];
	timeout_minutes: number;
	/** Hub-owned reminder interval; null/omit = no reminders. */
	remind_every_minutes?: number | null;
	actor_id?: string | null;
	/** Reviewer groups — each group has a policy (any/all) and channel targets. */
	reviewers?: ReviewerGroup[];
	/** Org ID for reviewer resolution scope. */
	org_id?: string | null;
	/**
	 * `input_pause` = form without policy (mid-phase inputs).
	 * `chat` = agent-initiated multi-turn conversation.
	 * Default / omit = verdict review with policy.
	 */
	mode?: 'input_pause' | 'verdict' | 'chat';
	/** Initial agent message for chat mode (stored as first review_chat_messages row). */
	initial_message?: string;
}

const log = get_logger('hug_reviews');

export interface SubmitVerdictInput {
	review_id: string;
	action: string;
	fields?: Record<string, unknown>;
	reviewer_name?: string;
	actor_id?: string | null;
	/** review_notifications row ID for per-destination audit. */
	notification_id?: string;
	/** Numeric user ID of the person submitting the verdict. */
	responded_by?: string;
}

/** A single reviewer notification row — exposed to the frontend for policy display. */
export interface ReviewNotificationDto {
	id: string;
	group_idx: number;
	channel_target: string;
	channel_id: string | null;
	user_id: string | null;
	responded_by: string | null;
	responded_at: string | null;
	action: string | null;
	comment: string | null;
}

/** A reviewer group with its policy and notification rows. */
export interface ReviewGroupDto {
	group_idx: number;
	policy: 'any' | 'all';
	channels: string[];
	/** Whether this group is satisfied per its policy. */
	satisfied: boolean;
	notifications: ReviewNotificationDto[];
}

export interface ReviewDto {
	id: string;
	run_id: string;
	run_name: string | null;
	daemon_id: string | null;
	realm_id: string | null;
	realm_name: string | null;
	realm_slug: string | null;
	org_slug: string | null;
	team: string | null;
	phase: string | null;
	payload: Record<string, unknown>;
	verdict: Record<string, unknown> | null;
	status: string;
	route_targets: string[] | null;
	created_at: Date;
	timeout_at: Date;
	completed_at: Date | null;
	artifacts: ReviewArtifactInfo[];
	/** Reviewer groups with per-destination notification status. */
	notification_groups?: ReviewGroupDto[];
	/** User ID of the reviewer who claimed this review for chat. */
	claimed_by: string | null;
	claimed_at: Date | null;
	/** Number of chat messages on this review. */
	message_count: number;
}

function public_hub_url(): string {
	return (process.env.PUBLIC_APP_URL
		|| process.env.CLIQHUB_PUBLIC_URL
		|| 'https://cliqhub.io').replace(/\/+$/, '');
}

function review_url_for(review_id: string): string {
	return `${public_hub_url()}/reviews/${review_id}`;
}

/**
 * Hub-native HUG reviews — replaces the separate hug microservice.
 * Verdicts are stored here and pushed to the daemon via its public_url (sync relay).
 */
export class HugReviewsService {
	static async create(input: CreateReviewInput): Promise<{ review_id: string; review_url: string }> {
		const id = randomBytes(32).toString('hex');
		const timeout_at = new Date(Date.now() + input.timeout_minutes * 60 * 1000);
		const mode = input.mode ?? 'verdict';

		/**
		 * Policy validation: 'all' is only valid with verdict mode.
		 * Chat and input modes are inherently single-responder interactions.
		 */
		const raw_reviewers = mode === 'input_pause' ? [] : (input.reviewers ?? []);
		const normalized_groups = _normalize_reviewer_groups(raw_reviewers);
		if (mode === 'chat' || mode === 'input_pause') {
			for (const group of normalized_groups) {
				if (group.policy === 'all') {
					throw ApiError.bad_request(
						`policy 'all' is not allowed with mode '${mode}' — chat and input reviews are single-responder`,
					);
				}
			}
		}

		const payload: Record<string, unknown> = {
			...input.payload,
			mode,
		};

		/**
		 * Resolve reviewer groups if provided and org context is available.
		 * The daemon may send either structured groups `[{policy, channels}]`
		 * or a flat array of username strings `["elan", "alice"]`. Normalize
		 * flat strings into a single `any` group before resolution.
		 * (Already normalized above for policy validation.)
		 */
		const reviewer_groups = normalized_groups;
		let resolved_groups: ResolvedGroup[] = [];
		if (reviewer_groups.length > 0 && input.org_id) {
			resolved_groups = await resolve_reviewer_groups(input.org_id, reviewer_groups);

			/**
			 * If any group resolved to zero destinations, log a warning and
			 * discard the explicit groups so the realm-broadcast fallback
			 * kicks in below. This is more resilient than hard-failing.
			 */
			const empty_group = resolved_groups.find((g, i) => {
				if (g.destinations.length === 0) {
					log.warn('reviewer_group_empty', { group_index: i, org_id: input.org_id });
					return true;
				}
				return false;
			});
			if (empty_group) {
				log.warn('reviewer_resolution_fallback_to_realm_broadcast', {
					review_id: id, org_id: input.org_id,
				});
				resolved_groups = [];
			}
		}

		/**
		 * Realm-broadcast fallback: no explicit reviewers configured — fan
		 * out to every user member of the realm. Each gets their own
		 * notification row with a real user_id so the frontend can match
		 * and policy evaluation works correctly.
		 */
		if (resolved_groups.length === 0 && input.realm_id) {
			const realm_members = await RealmMember.findAll({
				where: { realm_id: input.realm_id, member_type: 'user' },
				attributes: ['member_id'],
			});

			const destinations: Array<{
				target: string;
				user_id: string | null;
				channel_id: string | null;
				named_channel_id: string | null;
			}> = [];

			for (const rm of realm_members) {
				const user_id = String(rm.member_id);
				const user = await User.findByPk(user_id, { attributes: ['id', 'username'] });
				if (!user) continue;

				let channel_id: string | null = null;
				if (input.org_id) {
					try {
						channel_id = await ensure_per_user_channel(user_id, input.org_id, user.username);
					} catch {
						log.warn('realm_broadcast_ensure_channel_failed', { user_id, org_id: input.org_id });
					}
				}

				destinations.push({
					target: user.username,
					user_id,
					channel_id,
					named_channel_id: null,
				});
			}

			if (destinations.length === 0) {
				throw ApiError.bad_request(
					'No reviewers configured and realm has no user members — cannot create review',
				);
			}

			resolved_groups = [{ policy: 'any', destinations }];
			log.info('review_realm_broadcast_fanout', {
				review_id: id,
				realm_id: input.realm_id,
				user_count: destinations.length,
			});
		}

		/** Build the policy JSONB for storage. */
		const policy = {
			mode,
			groups: resolved_groups.map((g) => ({
				policy: g.policy,
				destinations: g.destinations.map((d) => ({
					target: d.target,
					user_id: d.user_id,
					channel_id: d.channel_id ?? d.named_channel_id,
				})),
			})),
		};

		await Review.create({
			id,
			run_id: input.run_id,
			daemon_id: input.daemon_id,
			realm_id: input.realm_id,
			org_id: input.org_id ?? null,
			payload,
			verdict: null,
			status: 'pending',
			route_targets: input.route_targets ?? null,
			policy,
			claimed_by: null,
			claimed_at: null,
			created_at: new Date(),
			timeout_at,
			completed_at: null,
			last_reminded_at: null,
			remind_every_minutes: input.remind_every_minutes ?? null,
		});

		/** Insert review_notifications rows — one per destination per group. */
		if (resolved_groups.length > 0) {
			const notification_rows = resolved_groups.flatMap((group, group_idx) =>
				group.destinations.map((dest) => ({
					id: randomUUID(),
					review_id: id,
					group_idx,
					channel_target: dest.target,
					channel_id: dest.channel_id ?? dest.named_channel_id ?? null,
					user_id: dest.user_id,
					responded_by: null,
					responded_at: null,
					action: null,
					comment: null,
					created_at: new Date(),
				})),
			);

			if (notification_rows.length > 0) {
				await ReviewNotification.bulkCreate(notification_rows);
				log.info('review_notifications_created', {
					review_id: id,
					count: notification_rows.length,
				});
			}
		}

		/** Chat mode: store the initial agent message. */
		if (mode === 'chat' && input.initial_message) {
			const { ReviewMessage } = await import('../models/review_message.model.js');
			const { randomUUID } = await import('node:crypto');
			await ReviewMessage.create({
				id: randomUUID(),
				review_id: id,
				role: 'assistant',
				text: input.initial_message,
				sender_id: null,
				created_at: new Date(),
			});
		}

		const review_url = review_url_for(id);
		const phase = typeof input.payload.phase === 'string' ? input.payload.phase : null;
		const team = typeof input.payload.team === 'string' ? input.payload.team : null;

		/** Collect all resolved channel IDs for targeted delivery. */
		const target_channels: string[] = [];
		for (const group of resolved_groups) {
			for (const dest of group.destinations) {
				if (dest.channel_id) target_channels.push(dest.channel_id);
				if (dest.named_channel_id) target_channels.push(dest.named_channel_id);
			}
		}

		/** Single event submission — rule-based routing + targeted delivery. */
		try {
			await EventSubmitService.submit({
				type: 'hug.review_requested',
				realm_id: input.realm_id,
				run_id: input.run_id,
				daemon_id: input.daemon_id,
				phase: phase ?? undefined,
				team: team ?? undefined,
				actor_id: input.actor_id ?? null,
				severity: 'info',
				title: `Review requested${phase ? ` — ${phase}` : ''}`,
				message: `A human review is needed for your run. Open review: ${review_url}`,
				payload: {
					review_id: id,
					review_url,
				},
				target_channels: [...new Set(target_channels)],
			});
		} catch (err) {
			log.error('review_event_submit_failed', {
				review_id: id,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		return { review_id: id, review_url };
	}

	static async get(review_id: string): Promise<ReviewDto> {
		const review = await Review.findByPk(review_id);
		if (!review) throw ApiError.not_found('Review not found');

		const { ReviewMessage } = await import('../models/review_message.model.js');
		const [run_info, realm_info, artifacts, enriched_payload, notification_rows, message_count] = await Promise.all([
			load_run_info_map([review.run_id]),
			review.realm_id ? load_realm_info_map([review.realm_id]) : Promise.resolve(new Map()),
			load_artifacts_for_run(review.run_id),
			_backfill_inputs_schema(review.payload, review.run_id),
			ReviewNotification.findAll({
				where: { review_id },
				order: [['group_idx', 'ASC'], ['channel_target', 'ASC']],
			}),
			ReviewMessage.count({ where: { review_id } }),
		]);
		const run = run_info.get(review.run_id);
		const realm = review.realm_id ? realm_info.get(review.realm_id) : undefined;
		const phase = typeof enriched_payload.phase === 'string' ? enriched_payload.phase : null;

		/** Build notification groups from the review's stored policy + notification rows. */
		const notification_groups = _build_notification_groups(review.policy, notification_rows);

		return {
			id: review.id,
			run_id: review.run_id,
			run_name: run?.run_name ?? null,
			daemon_id: review.daemon_id,
			realm_id: review.realm_id,
			realm_name: realm?.realm_name ?? null,
			realm_slug: realm?.realm_slug ?? null,
			org_slug: realm?.org_slug ?? null,
			team: resolve_team(enriched_payload, run),
			phase,
			payload: enriched_payload,
			verdict: review.verdict,
			status: review.status,
			route_targets: review.route_targets,
			created_at: review.created_at,
			timeout_at: review.timeout_at,
			completed_at: review.completed_at,
			artifacts,
			notification_groups,
			claimed_by: review.claimed_by ?? null,
			claimed_at: review.claimed_at ?? null,
			message_count,
		};
	}

	static async submit_verdict(input: SubmitVerdictInput): Promise<{ status: string }> {
		const review = await Review.findByPk(input.review_id);
		if (!review) throw ApiError.not_found('Review not found');

		if (review.status !== 'pending') {
			if (review.status === 'expired') throw ApiError.gone('Review has expired');
			throw ApiError.conflict(`Review is already ${review.status}`);
		}

		if (input.action.startsWith('ROUTE:')) {
			const target = input.action.slice(6);
			if (review.route_targets && !review.route_targets.includes(target)) {
				throw ApiError.bad_request(
					`Invalid route target: ${target}. Allowed: ${review.route_targets.join(', ')}`,
				);
			}
		}

		/** notification_id is required — every reviewer must have an assigned ballot. */
		if (!input.notification_id) {
			throw ApiError.bad_request(
				'notification_id is required — no reviewer assignment found for this user',
			);
		}

		/** Record response on the notification row (audit trail). */
		await ReviewNotification.update(
			{
				responded_by: input.responded_by ?? null,
				responded_at: new Date(),
				action: input.action,
				comment: input.fields?.['comment'] ? String(input.fields['comment']) : null,
			},
			{ where: { id: input.notification_id, review_id: input.review_id } },
		);

		/** Evaluate policy to decide if the review is fully decided. */
		const policy_satisfied = await _evaluate_policy(review);

		if (!policy_satisfied) {
			/** Policy not yet satisfied — stay pending. */
			log.info('review_response_recorded_pending', {
				review_id: input.review_id,
				notification_id: input.notification_id,
				action: input.action,
			});
			return { status: 'pending' };
		}

		const verdict: Record<string, unknown> = {
			action: input.action,
			fields: input.fields ?? {},
			/** Legacy field — kept for backward compat; prefer responded_by. */
			reviewer_name: input.reviewer_name ?? null,
			responded_by: input.responded_by ?? null,
			decided_at: new Date().toISOString(),
		};
		if (input.fields?.['comment']) verdict['comment'] = input.fields['comment'];

		const [updated] = await Review.update(
			{ verdict, status: 'decided' },
			{ where: { id: input.review_id, status: 'pending' } },
		);
		if (!updated) throw ApiError.conflict('Review is no longer pending');

		/** Resolve target channels — all HUG events for this
		 *  review deliver to the same channels the request was sent to. */
		let review_channels: string[] = [];
		try {
			const notif_rows = await ReviewNotification.findAll({
				where: { review_id: input.review_id },
				attributes: ['channel_id'],
			});
			review_channels = [
				...new Set(
					notif_rows
						.map((r) => r.channel_id)
						.filter((cid): cid is string => cid != null),
				),
			];
		} catch (err) {
			log.error('verdict_channel_resolution_failed', {
				review_id: input.review_id,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		log.info('verdict_event_context', {
			review_id: input.review_id,
			review_channels,
			realm_id: review.realm_id,
			daemon_id: review.daemon_id,
		});

		try {
			await EventSubmitService.submit({
				type: 'hug.review_responded',
				realm_id: review.realm_id ?? undefined,
				run_id: review.run_id,
				daemon_id: review.daemon_id ?? undefined,
				actor_id: input.actor_id ?? null,
				payload: {
					review_id: input.review_id,
					review_url: review_url_for(input.review_id),
					action: input.action,
				},
				target_channels: review_channels,
			});
		} catch (err) {
			log.error('review_responded_event_failed', {
				review_id: input.review_id,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		/** Terminal event — review is fully resolved. */
		try {
			await EventSubmitService.submit({
				type: 'hug.review_resolved',
				realm_id: review.realm_id ?? undefined,
				run_id: review.run_id,
				daemon_id: review.daemon_id ?? undefined,
				actor_id: input.actor_id ?? null,
				payload: {
					review_id: input.review_id,
					review_url: review_url_for(input.review_id),
					action: input.action,
					decided_at: verdict.decided_at,
				},
				target_channels: review_channels,
			});
		} catch (err) {
			log.error('review_resolved_event_failed', {
				review_id: input.review_id,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		await HugReviewsService.push_verdict_to_daemon(review.daemon_id, {
			review_id: input.review_id,
			run_id: review.run_id,
			verdict,
		});

		// Yamazaki input_pause: merge field values into run inputs (not only hug verdict).
		const payload_mode = (review.payload as Record<string, unknown> | null)?.['mode'];
		const policy_mode = (review.policy as Record<string, unknown> | null)?.['mode'];
		if (
			(payload_mode === 'input_pause' || policy_mode === 'input_pause')
			&& input.action === 'PASS'
		) {
			const values_raw = input.fields?.['values'];
			const values = (values_raw && typeof values_raw === 'object' && !Array.isArray(values_raw))
				? values_raw as Record<string, unknown>
				: {};
			if (Object.keys(values).length > 0) {
				try {
					const { DispatchService } = await import('./dispatch.service.js');
					await DispatchService.supply_inputs({
						run_id: review.run_id,
						inputs: values,
						user_id: String(input.responded_by ?? input.actor_id ?? 'hug'),
					});
				} catch (err) {
					log.error('input_pause_supply_inputs_failed', {
						review_id: input.review_id,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}

		return { status: 'decided' };
	}

	// ── Access control helpers ──────────────────────────────────────

	/**
	 * Check if a user has access to the given review via a notification row.
	 *
	 * Two paths:
	 *   1. Direct: a review_notifications row targets this user_id.
	 *   2. Realm-broadcast: a shared-channel row (user_id IS NULL) exists
	 *      and the user is a member of the review's realm.
	 */
	static async has_notification_for_user(
		review_id: string,
		user_id: string,
	): Promise<boolean> {
		const direct = await ReviewNotification.findOne({
			where: { review_id, user_id },
			attributes: ['id'],
		});
		if (direct) return true;

		const shared = await ReviewNotification.findOne({
			where: { review_id, user_id: { [Op.is]: null } },
			attributes: ['id'],
		});
		if (!shared) return false;

		const review = await Review.findByPk(review_id, { attributes: ['realm_id'] });
		if (!review?.realm_id) return false;

		return _is_realm_member(review.realm_id, user_id);
	}

	/**
	 * Authorize a verdict submission via notification_id.
	 *
	 * - User-targeted notifications: only the assigned user can respond.
	 * - Shared-channel notifications (user_id IS NULL): any user who is
	 *   a member of the review's realm can respond. Membership is enforced
	 *   here — the reviews.verdict endpoint itself is auth-only, so we
	 *   must not trust "authenticated" to mean "authorized" for broadcast.
	 *
	 * @throws ApiError.forbidden if the user is not allowed.
	 */
	static async authorize_verdict_via_notification(
		notification_id: string,
		review_id: string,
		user_id: string,
	): Promise<void> {
		const notif = await ReviewNotification.findOne({
			where: { id: notification_id, review_id },
		});
		if (!notif) {
			throw ApiError.forbidden('Invalid notification for this review');
		}

		if (notif.responded_at) {
			throw ApiError.conflict('This notification has already been responded to');
		}

		/** User-targeted: only the assigned user. */
		if (notif.user_id !== null) {
			if (notif.user_id !== user_id) {
				throw ApiError.forbidden('This review notification is assigned to another user');
			}
			return;
		}

		/** Shared-channel: require membership in the review's realm. */
		const review = await Review.findByPk(review_id, { attributes: ['realm_id'] });
		if (!review?.realm_id) {
			throw ApiError.forbidden('Review has no realm scope for broadcast verdict');
		}
		const is_member = await _is_realm_member(review.realm_id, user_id);
		if (!is_member) {
			throw ApiError.forbidden('You are not a member of this realm');
		}
	}

	/** Push verdict to the daemon via the unified HUG inbox. */
	static async push_verdict_to_daemon(
		daemon_id: string | null,
		body: { review_id: string; run_id: string; verdict: Record<string, unknown> },
	): Promise<void> {
		if (!daemon_id) return;

		const { command_outbox_enqueue } = await import('./command_outbox.service.js');
		await command_outbox_enqueue(daemon_id, '/v1/hug/inbox', {
			review_id: body.review_id,
			run_id: body.run_id,
			type: 'verdict',
			role: 'user',
			payload: body.verdict,
		});
	}

	static async ack(review_id: string, run_id: string): Promise<{ status: string }> {
		const review = await Review.findByPk(review_id);
		if (!review) throw ApiError.not_found('Review not found');
		if (review.run_id !== run_id) throw ApiError.forbidden('Run ID mismatch');
		if (review.status !== 'decided') {
			throw ApiError.conflict(`Cannot ack review in status: ${review.status}`);
		}

		await Review.update(
			{ status: 'completed', completed_at: new Date() },
			{ where: { id: review_id, status: 'decided' } },
		);
		return { status: 'completed' };
	}

	/**
	 * Emit a reminder for a pending review (Hub sweep only).
	 * Emits `hug.review_reminded` to the same target_channels as the
	 * original request — purely informational.
	 */
	static async remind(review_id: string): Promise<{ ok: boolean }> {
		const review = await Review.findByPk(review_id);
		if (!review) throw ApiError.not_found('Review not found');
		if (review.status !== 'pending') return { ok: false };

		/** Do not remind for terminal runs (cancel/fail left the review pending). */
		if (review.run_id) {
			const run = await Run.findByPk(review.run_id, { attributes: ['state'] });
			const state = run?.get('state') as string | undefined;
			if (state && !['running', 'awaiting_input'].includes(state)) {
				return { ok: false };
			}
		}

		/** Collect channels from the notification rows. */
		const notif_rows = await ReviewNotification.findAll({
			where: { review_id },
			attributes: ['channel_id'],
		});
		const channels = [
			...new Set(
				notif_rows
					.map((r) => r.channel_id)
					.filter((cid): cid is string => cid != null),
			),
		];

		await Promise.all([
			Review.update(
				{ last_reminded_at: new Date() },
				{ where: { id: review_id } },
			),
			EventSubmitService.submit({
				type: 'hug.review_reminded',
				realm_id: review.realm_id ?? undefined,
				run_id: review.run_id,
				daemon_id: review.daemon_id ?? undefined,
				payload: { review_id, review_url: review_url_for(review_id) },
				target_channels: channels,
			}),
		]);

		return { ok: true };
	}

	/**
	 * Expire all pending HUG reviews for a run (cancel / fail / crash /
	 * force-terminate). Emits `hug.review_expired` so badges and inbox
	 * semantics clear; stops further `hug.review_reminded` growth.
	 */
	static async expire_pending_for_run(run_id: string): Promise<number> {
		const pending = await Review.findAll({
			where: { run_id, status: 'pending' },
			attributes: ['id', 'run_id', 'daemon_id', 'realm_id'],
		});
		if (pending.length === 0) return 0;

		const ids = pending.map((r) => r.id);
		await Review.update(
			{ status: 'expired', completed_at: new Date() },
			{ where: { id: { [Op.in]: ids }, status: 'pending' } },
		);

		for (const row of pending) {
			try {
				const notif_rows = await ReviewNotification.findAll({
					where: { review_id: row.id },
					attributes: ['channel_id'],
				});
				const channels = [
					...new Set(
						notif_rows
							.map((r) => r.channel_id)
							.filter((cid): cid is string => cid != null),
					),
				];
				await EventSubmitService.submit({
					type: 'hug.review_expired',
					realm_id: row.realm_id ?? undefined,
					run_id: row.run_id,
					daemon_id: row.daemon_id ?? undefined,
					payload: {
						review_id: row.id,
						review_url: review_url_for(row.id),
					},
					target_channels: channels,
				});
			} catch (err) {
				get_logger('hug-reviews').error('expire_pending_emit_failed', {
					review_id: row.id,
					run_id,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return pending.length;
	}


	static issue_run_token(params: {
		user_id: string;
		run_id: string;
		team: string;
		phases: string[];
		ttl_hours?: number;
	}): string {
		const env = load_env();
		return jwt.sign(
			{
				sub: params.user_id,
				run_id: params.run_id,
				team: params.team,
				phases: params.phases,
				purpose: 'hug_run',
			},
			env.jwt_secret,
			{ expiresIn: `${params.ttl_hours ?? 4}h` },
		);
	}

	static verify_run_token(token: string): { run_id: string; sub: string } | null {
		try {
			const env = load_env();
			const decoded = jwt.verify(token, env.jwt_secret) as jwt.JwtPayload;
			if (typeof decoded.run_id !== 'string' || typeof decoded.sub !== 'string') return null;
			return { run_id: decoded.run_id, sub: decoded.sub };
		} catch {
			return null;
		}
	}
}


// ── Realm membership helper ─────────────────────────────────────────

/**
 * Check if `user_id` is a member of `realm_id`. Used by the
 * shared-channel verdict auth path — a broadcast notification is
 * only actionable by users in the review's realm.
 */
async function _is_realm_member(realm_id: string, user_id: string): Promise<boolean> {
	const member = await RealmMember.findOne({
		where: {
			realm_id,
			member_type: 'user',
			member_id: String(user_id),
		},
		attributes: ['id'],
	});
	return member !== null;
}


// ── Policy evaluation ───────────────────────────────────────────────

interface PolicyGroup {
	policy: 'any' | 'all';
	destinations: Array<{ target: string; user_id: string | null; channel_id: string | null }>;
}

/**
 * Evaluate whether a review's policy is fully satisfied based on
 * the current state of review_notifications rows.
 *
 * - Reviews with no policy groups (legacy) → immediately satisfied.
 * - `any` group: satisfied if ≥1 destination in the group has responded.
 * - `all` group: satisfied if every destination in the group has responded.
 * - All groups must be satisfied for the review to be decided.
 */

/**
 * Normalize reviewer input into structured groups. The daemon may send
 * either structured `[{policy, channels}]` or a flat `["username", ...]`.
 * Flat strings are wrapped into a single `any` group.
 */
function _normalize_reviewer_groups(raw: unknown[]): ReviewerGroup[] {
	if (raw.length === 0) return [];

	/** Already structured — has `policy` and `channels` keys. */
	const first = raw[0];
	if (first && typeof first === 'object' && 'policy' in first && 'channels' in first) {
		return raw as ReviewerGroup[];
	}

	/** Flat string array — wrap into a single "any" group. */
	const channels = raw.filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
	if (channels.length === 0) return [];
	return [{ policy: 'any', channels }];
}

async function _evaluate_policy(
	review: import('../models/review.model.js').ReviewModel,
): Promise<boolean> {
	const policy = review.policy as { groups?: PolicyGroup[] } | null;
	const groups = policy?.groups;

	/** Legacy reviews (no groups) are immediately decided on first response. */
	if (!groups || groups.length === 0) return true;

	/** Load all notification rows for this review. */
	const notifications = await ReviewNotification.findAll({
		where: { review_id: review.id },
		attributes: ['group_idx', 'responded_at', 'action'],
	});

	/** Build a map: group_idx → { total, approved, responded }. */
	const group_stats = new Map<number, { total: number; approved: number; responded: number }>();
	for (const n of notifications) {
		const idx = n.group_idx;
		const stats = group_stats.get(idx) ?? { total: 0, approved: 0, responded: 0 };
		stats.total += 1;
		if (n.responded_at) {
			stats.responded += 1;
			if (n.action === 'PASS') stats.approved += 1;
		}
		group_stats.set(idx, stats);
	}

	/**
	 * Check each group's policy.
	 *   any  — at least one PASS (rejects don't satisfy; review
	 *          stays pending until someone approves or it times out).
	 *   all  — every destination must respond with PASS.
	 */
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i];
		const stats = group_stats.get(i);
		if (!stats || stats.total === 0) return false;

		if (group.policy === 'any' && stats.approved < 1) return false;
		if (group.policy === 'all' && stats.approved < stats.total) return false;
	}

	return true;
}


// ── Notification group builder for review detail ────────────────────

/**
 * Build `ReviewGroupDto[]` from a review's stored policy JSON and
 * its `review_notifications` rows. Used by `get()` to expose group
 * structure and per-destination response status in the API.
 */
function _build_notification_groups(
	policy: Record<string, unknown> | null,
	notification_rows: Array<{
		id: string;
		group_idx: number;
		channel_target: string;
		channel_id: string | null;
		user_id: string | null;
		responded_by: string | null;
		responded_at: Date | null;
		action: string | null;
		comment: string | null;
	}>,
): ReviewGroupDto[] {
	const groups_def = (policy as { groups?: Array<{ policy: 'any' | 'all'; channels?: string[] }> })?.groups;
	if (!groups_def || groups_def.length === 0) return [];

	/** Index notification rows by group_idx. */
	const by_group = new Map<number, typeof notification_rows>();
	for (const row of notification_rows) {
		const arr = by_group.get(row.group_idx) ?? [];
		arr.push(row);
		by_group.set(row.group_idx, arr);
	}

	return groups_def.map((def, idx) => {
		const notifs = by_group.get(idx) ?? [];

		const notif_dtos: ReviewNotificationDto[] = notifs.map((n) => ({
			id: n.id,
			group_idx: n.group_idx,
			channel_target: n.channel_target,
			channel_id: n.channel_id,
			user_id: n.user_id,
			responded_by: n.responded_by,
			responded_at: n.responded_at ? n.responded_at.toISOString() : null,
			action: n.action,
			comment: n.comment,
		}));

		/** Evaluate satisfaction — only PASS responses count. */
		const approved_count = notifs.filter((n) => n.responded_at && n.action === 'PASS').length;
		const satisfied = def.policy === 'any'
			? approved_count >= 1
			: approved_count >= notifs.length && notifs.length > 0;

		return {
			group_idx: idx,
			policy: def.policy,
			channels: def.channels ?? [],
			satisfied,
			notifications: notif_dtos,
		};
	});
}
