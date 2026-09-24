import { randomUUID } from 'node:crypto';

import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';
import { get_notification_handler } from '../notifications/handlers/index.js';
import { CustomEventService } from '../services/custom_event.service.js';
import type { NotificationDispatchStatus } from '../notifications/types.js';
import {
	EVENT_TYPE_SEVERITY,
	type EventSeverity,
	type EventType,
} from './types.js';
import { event_submit_schema } from './submit_schema.js';
import { HubEvent } from './event.model.js';

const log = get_logger('events');

export interface SubmitEventInput {
	type: string;
	occurred_at?: string;
	realm_id?: string;
	org_id?: string;
	team?: string;
	run_id?: string;
	phase?: string;
	daemon_id?: string;
	title?: string;
	message?: string;
	severity?: EventSeverity;
	payload?: Record<string, unknown>;
	actor_id?: string | null;
	/**
	 * Optional targeted channel IDs. When present, the event is delivered
	 * to these channels IN ADDITION TO rule-based routing. This is the
	 * mechanism for targeted notifications (e.g., HUG review → specific
	 * reviewer channels, delegation → new reviewer channel).
	 */
	target_channels?: string[];
}

export interface SubmittedEvent {
	id: string;
	type: EventType;
	occurred_at: string;
	realm_id: string | null;
	org_id: string | null;
	team: string | null;
	run_id: string | null;
	phase: string | null;
	daemon_id: string | null;
	title: string | null;
	message: string | null;
	severity: EventSeverity;
	payload: Record<string, unknown>;
	actor_id: string | null;
	created_at: number;
	notifications: NotificationDispatchStatus;
}

function to_dto(
	row: HubEvent,
	notifications: NotificationDispatchStatus = 'deferred',
): SubmittedEvent {
	let payload: Record<string, unknown> = {};
	try {
		payload = JSON.parse(row.payload_json) as Record<string, unknown>;
	} catch {
		payload = {};
	}

	const type = row.type as EventType;
	const severity = (row.severity as EventSeverity | null)
		?? EVENT_TYPE_SEVERITY[type as keyof typeof EVENT_TYPE_SEVERITY]
		?? 'info';

	return {
		id: row.id,
		type,
		occurred_at: row.occurred_at,
		realm_id: row.realm_id,
		org_id: row.org_id,
		team: row.team,
		run_id: row.run_id,
		phase: row.phase,
		daemon_id: row.daemon_id,
		title: row.title,
		message: row.message,
		severity,
		payload,
		actor_id: row.actor_id,
		created_at: row.created_at,
		notifications,
	};
}

/**
 * Accept a typed event onto the Hub event bus.
 * Persists the event, then dispatches notification handlers by EventType registry.
 */
export class EventSubmitService {
	static async submit(input: SubmitEventInput): Promise<SubmittedEvent> {
		// Zod catalog + family-required fields (also used by EventsController).
		const body = event_submit_schema.parse({
			type: input.type,
			occurred_at: input.occurred_at,
			realm_id: input.realm_id,
			org_id: input.org_id,
			team: input.team,
			run_id: input.run_id,
			phase: input.phase,
			daemon_id: input.daemon_id,
			title: input.title,
			message: input.message,
			severity: input.severity,
			payload: input.payload,
		});

		const type = body.type as EventType;
		const occurred_at = body.occurred_at?.trim()
			? body.occurred_at.trim()
			: new Date().toISOString();
		const severity = body.severity
			?? EVENT_TYPE_SEVERITY[type as keyof typeof EVENT_TYPE_SEVERITY]
			?? 'info';
		const now = Date.now();
		const id = randomUUID();

		// Auto-resolve org_id from realm when not explicitly provided.
		let resolved_org_id = body.org_id?.trim() || null;
		if (!resolved_org_id && body.realm_id?.trim()) {
			try {
				const { Realm } = await import('../models/index.js');
				const realm = await Realm.findByPk(body.realm_id.trim(), { attributes: ['org_id'] });
				if (realm?.org_id) resolved_org_id = String(realm.org_id);
			} catch { /* best-effort */ }
		}

		const row = await HubEvent.create({
			id,
			type,
			occurred_at,
			realm_id: body.realm_id?.trim() || null,
			org_id: resolved_org_id,
			team: body.team?.trim() || null,
			run_id: body.run_id?.trim() || null,
			phase: body.phase?.trim() || null,
			daemon_id: body.daemon_id?.trim() || null,
			title: body.title ?? null,
			message: body.message ?? null,
			severity,
			payload_json: JSON.stringify(body.payload ?? {}),
			actor_id: input.actor_id ?? null,
			created_at: now,
		});

		if (type.startsWith('custom.')) {
			CustomEventService.register_observed({
				event_type: type,
				realm_id: body.realm_id ?? null,
				team_slug: body.team ?? null,
			}).catch(() => {});
		}

		const dto = to_dto(row, 'deferred');
		let notifications: NotificationDispatchStatus = 'skipped';

		/** Rule-based routing via the event handler. */
		try {
			const handler = get_notification_handler(type as string);
			notifications = await handler.handle(dto);
		} catch (err) {
			notifications = 'failed';
			log.error(
				`notification handler failed for ${type}: `
				+ (err instanceof Error ? err.message : String(err)),
			);
		}

		/** Targeted delivery to specific channels (in addition to rules). */
		const targets = input.target_channels ?? [];
		if (targets.length > 0) {
			try {
				const { NotificationFanOutService } = await import('../notifications/fan_out.service.js');
				const targeted_status = await NotificationFanOutService.deliver_to_channels(targets, dto);
				if (notifications === 'skipped') notifications = targeted_status;
			} catch (err) {
				log.error(
					`targeted delivery failed for ${type}: `
					+ (err instanceof Error ? err.message : String(err)),
				);
				if (notifications === 'skipped') notifications = 'failed';
			}
		}

		log.info(`event submitted: ${type} id=${id} notifications=${notifications}`);
		return { ...dto, notifications };
	}

	static async get(id: string): Promise<SubmittedEvent> {
		const row = await HubEvent.findByPk(id);
		if (!row) throw ApiError.not_found(`event '${id}' not found`);
		return to_dto(row, 'deferred');
	}
}
