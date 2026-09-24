import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import {
	EVENT_TYPES,
	EventSubmitService,
	event_submit_schema,
} from '../events/index.js';
import { CustomEventService } from '../services/custom_event.service.js';
import {
	require_authenticated_user_id,
	require_realm_notification_admin,
} from '../notifications/notification_authz.js';
import { ApiError } from '../lib/api_error.js';

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

export class EventsController {
	/** POST /v1/events/submit — typed event; Zod enforces catalog + family-required fields. */
	static async submit(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const body = event_submit_schema.parse(req.body ?? {});
			const actor_id = req.user?.user_id ?? null;
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
			const { id } = get_by_id_schema.parse(req.body ?? {});
			const event = await EventSubmitService.get(id);
			res.json({ ok: true, event });
		} catch (err) { next(err); }
	}

	/** POST /v1/events/types/list — fixed catalog for clients. */
	static async types_list(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			types_list_schema.parse(req.body ?? {});
			res.json({ ok: true, types: [...EVENT_TYPES] });
		} catch (err) { next(err); }
	}

	/** POST /v1/events/custom/list — dynamic custom.* events (declared + observed). */
	static async custom_list(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const { realm_id, team_slug } = custom_list_schema.parse(req.body ?? {});
			const events = await CustomEventService.list({ realm_id, team_slug });
			res.json({ ok: true, events });
		} catch (err) { next(err); }
	}

	/** POST /v1/events/custom/create — manually register a custom event type. */
	static async custom_create(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = require_authenticated_user_id(req);
			const data = custom_create_schema.parse(req.body ?? {});
			await require_realm_notification_admin(data.realm_id, user_id);

			const event = await CustomEventService.create_manual({
				event_type: data.event_type,
				realm_id: data.realm_id,
				label: data.label ?? null,
			});
			res.json({ ok: true, event });
		} catch (err) { next(err); }
	}

	/** POST /v1/events/custom/remove — delete a manually-created custom event. */
	static async custom_remove(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = require_authenticated_user_id(req);
			const { id } = custom_remove_schema.parse(req.body ?? {});
			const event = await CustomEventService.get(id);
			if (!event) throw ApiError.not_found('Custom event not found');
			if (event.realm_id) {
				await require_realm_notification_admin(event.realm_id, user_id);
			}
			await CustomEventService.remove(id);
			res.json({ ok: true, removed: true });
		} catch (err) { next(err); }
	}
}
