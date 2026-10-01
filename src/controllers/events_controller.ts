import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import {
	EVENT_TYPES,
	event_submit_schema,
} from '../schemas/event_types.js';
import { EventSubmitService } from '../services/events_service.js';
import { CustomEventService } from '../services/custom_event.service.js';
import {
	require_authenticated_user_id,
} from '../notifications/notification_authz.js';
import { ApiError } from '../lib/api_error.js';
import { AdminCheck } from '../lib/site_admin.js';
import { RealmService } from '../services/realm.service.js';
import { visible_realm_ids } from '../auth/route_policy/visible.js';
import { Realm, Run } from '../models/index.js';
import { get_logger } from '../lib/log.js';

const get_by_id_schema = z.object({
	id: z.string().min(1).describe('Persisted event id'),
});

const types_list_schema = z.object({}).describe('Empty body — returns the fixed Hub catalog');

const custom_list_schema = z.object({
	realm_id: z.string().optional().describe('Filter by realm'),
	team_slug: z.string().optional().describe('Filter by team slug'),
});

const custom_create_schema = z.object({
	event_type: z
		.string()
		.min(1)
		.regex(/^custom\..+/)
		.describe('Must be custom.<name>'),
	realm_id: z.string().min(1).describe('Realm that owns this custom type'),
	label: z.string().optional().describe('Optional display label'),
});

const custom_remove_schema = z.object({
	id: z.string().uuid().describe('Custom event row id'),
});

const log = get_logger('ctrl.events');

/**
 * An event may only name records of its own realm (S11): the run must live in
 * `realm_id`, a daemon token may only speak for daemons of its realm, and an
 * org-only event from a daemon must be for the token realm's org. The route
 * policy has already checked the caller's standing in `realm_id` / `org_id`.
 */
async function assert_event_scope(
	req: Request,
	body: { realm_id?: string; org_id?: string; run_id?: string; daemon_id?: string },
): Promise<void> {
	const auth = req.auth;
	if (body.run_id) {
		const run = await Run.findOne({ where: { run_id: body.run_id }, attributes: ['realm_id'], raw: true }) as { realm_id: string | null } | null;
		if (!run) throw ApiError.not_found('Run not found');
		if (body.realm_id && run.realm_id !== body.realm_id) throw ApiError.not_found('Run not found in this realm');
		if (!body.realm_id && run.realm_id && !AdminCheck.is_site_admin(req)) {
			// Run named without a realm: the caller must be able to see the run's realm.
			const visible = auth?.auth_via === 'daemon_token'
				? [auth.realm_id]
				: await visible_realm_ids(String(auth?.user?.id ?? ''), { need: 'operate' });
			if (!visible.includes(run.realm_id)) throw ApiError.not_found('Run not found');
		}
	}
	if (auth?.auth_via === 'daemon_token') {
		if (!auth.realm_id) throw ApiError.forbidden('Daemon token has no realm');
		if (body.daemon_id) await RealmService.assert_daemon_in_realm(auth.realm_id, body.daemon_id);
		if (!body.realm_id && body.org_id) {
			const realm = await Realm.findOne({ where: { id: auth.realm_id }, attributes: ['org_id'], raw: true }) as { org_id: string | null } | null;
			if (!realm || realm.org_id !== body.org_id) throw ApiError.forbidden('org_id is not the token realm’s org');
		}
	}
}

export class EventsController {
	/** POST /v1/events/submit — typed event; Zod enforces catalog + family-required fields. */
	static async submit(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			log.debug('submit', { user_id: req.auth?.user?.id });
			const body = event_submit_schema.parse(req.body ?? {});
			await assert_event_scope(req, body);
			const actor_id = req.auth?.user?.id ?? null;
			const event = await EventSubmitService.submit({
				...body,
				actor_id,
			});
			res.json({ ok: true, event });
		} catch (err) { next(err); }
	}

	/** POST /v1/events/get_by_id */
	static async get_by_id(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			log.debug('get_by_id', { user_id: req.auth?.user?.id });
			const { id } = get_by_id_schema.parse(req.body ?? {});
			const event = await EventSubmitService.get(id);
			res.json({ ok: true, event });
		} catch (err) { next(err); }
	}

	/** POST /v1/events/types/list — fixed catalog for clients. */
	static async types_list(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			log.debug('types_list', { user_id: req.auth?.user?.id });
			types_list_schema.parse(req.body ?? {});
			res.json({ ok: true, types: [...EVENT_TYPES] });
		} catch (err) { next(err); }
	}

	/** POST /v1/events/custom/list — dynamic custom.* events (declared + observed). */
	static async custom_list(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			log.debug('custom_list', { user_id: req.auth?.user?.id });
			const { realm_id, team_slug } = custom_list_schema.parse(req.body ?? {});
			// Without a realm this lists every custom event on the hub: site admins only (S19).
			if (!realm_id && !AdminCheck.is_site_admin(req)) {
				throw ApiError.forbidden('realm_id is required');
			}
			const events = await CustomEventService.list({ realm_id, team_slug });
			res.json({ ok: true, events });
		} catch (err) { next(err); }
	}

	/** POST /v1/events/custom/create — manually register a custom event type. */
	static async custom_create(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = require_authenticated_user_id(req);
			log.debug('custom_create', { user_id });
			// Route policy: operate + rules.manage.realm in data.realm_id.
			const data = custom_create_schema.parse(req.body ?? {});

			const event = await CustomEventService.create_manual({
				event_type: data.event_type,
				realm_id: data.realm_id,
				label: data.label ?? null,
			});
			log.info('custom_event_created', { id: event.id });
			res.json({ ok: true, event });
		} catch (err) { next(err); }
	}

	/** POST /v1/events/custom/remove — delete a manually-created custom event. */
	static async custom_remove(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = require_authenticated_user_id(req);
			log.debug('custom_remove', { user_id });
			const { id } = custom_remove_schema.parse(req.body ?? {});
			// Route policy: operate + rules.manage.realm in the event's realm;
			// hub-wide (no realm) custom events: site admins only (S20).
			await CustomEventService.remove(id);
			log.info('custom_event_removed', { id });
			res.json({ ok: true, removed: true });
		} catch (err) { next(err); }
	}
}
