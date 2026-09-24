import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { NotificationService } from '../services/notification.service.js';
import { InAppNotificationService } from '../services/in_app_notification.service.js';
import { ApiError } from '../lib/api_error.js';
import {
	require_account_notification_admin,
	require_authenticated_user_id,
	require_realm_notification_admin,
	require_realm_notification_member,
} from '../notifications/notification_authz.js';
import { destination_schema } from '../notifications/channel_config.js';

const channels_get_schema = z.object({
	realm_id: z.string().min(1).optional(),
	/** List account-owned channels (realm_id IS NULL). */
	account: z.boolean().optional(),
	enabled: z.boolean().optional(),
	ids: z.array(z.string()).optional(),
	/** Substring match on channel name (POST body only). */
	query: z.string().optional(),
}).superRefine((data, ctx) => {
	const has_realm = Boolean(data.realm_id?.trim());
	const want_account = data.account === true || !has_realm;
	if (want_account && has_realm) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['realm_id'],
			message: 'Do not set realm_id when listing account channels',
		});
	}
});

const channels_create_schema = z.object({
	realm_id: z.string().min(1).optional(),
	name: z.string(),
	destinations: z.array(destination_schema).min(1),
	enabled: z.boolean().optional(),
});
const channels_update_schema = z.object({
	id: z.string(),
	name: z.string().optional(),
	/** Replace the channel's destinations. */
	destinations: z.array(destination_schema).min(1).optional(),
	enabled: z.boolean().optional(),
});
const channels_remove_schema = z.object({ id: z.string() });

const channels_test_schema = z.object({
	id: z.string(),
	/** Optional: test only the destination at this index. */
	destination_index: z.number().int().nonnegative().optional(),
});

const rules_list_schema = z.object({
	realm_id: z.string().min(1).optional(),
	team_slug: z.string().min(1).optional(),
	/** When true, returns the effective rules (global + realm overrides). */
	effective: z.boolean().optional(),
});
const rules_set_schema = z.object({
	realm_id: z.string().min(1).optional(),
	team_slug: z.string().min(1).optional(),
	event: z.string().min(1),
	channel_id: z.string().min(1),
	priority: z.number().int().optional(),
});
const rules_remove_schema = z.object({ id: z.string().uuid() });

const inbox_list_schema = z.object({
	realm_id: z.string().optional(),
	realms: z.array(z.string()).optional(),
	types: z.array(z.string()).optional(),
	severities: z.array(z.string()).optional(),
	teams: z.array(z.string()).optional(),
	run_id: z.string().optional(),
	phases: z.array(z.string()).optional(),
	q: z.string().optional(),
	since_ms: z.number().optional(),
	until_ms: z.number().optional(),
	/** When true, only return events for runs the caller initiated. */
	initiated_by_me: z.boolean().optional(),
	limit: z.number().int().positive().optional(),
	offset: z.number().int().nonnegative().optional(),
}).optional();

/**
 * Org boundary guard for channel operations.
 * Realm-scoped channels: realm.org_id must match current_org_id.
 * Org-scoped (account-level) channels: channel.org_id must match.
 */
async function assert_channel_in_org(
    channel: { realm_id: string | null; org_id?: string | null },
    current_org_id: string | undefined,
): Promise<void> {
    if (!current_org_id) return;

    if (channel.realm_id) {
        const { Realm } = await import('../models/index.js');
        const realm = await Realm.findByPk(channel.realm_id, { attributes: ['org_id'] });
        if (realm && realm.org_id !== current_org_id) {
            throw ApiError.forbidden('Channel does not belong to the active org');
        }
        return;
    }

    if (channel.org_id && channel.org_id !== current_org_id) {
        throw ApiError.forbidden('Channel does not belong to the active org');
    }
}

export class NotificationController {
	static async channels_get(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = require_authenticated_user_id(req);
			const org_id = req.user?.current_org_id;
			const body = channels_get_schema.parse(req.body ?? {});
			const realm_id = body.realm_id?.trim();
			const want_account = body.account === true || !realm_id;

			if (want_account) {
				const channels = await NotificationService.list_channels({
					account: true,
					org_id,
					query: body.query,
				});
				res.json({
					ok: true,
					channels: body.enabled === true ? channels.filter((ch) => ch.enabled) : channels,
				});
				return;
			}

			await require_realm_notification_member(realm_id!, user_id);
			if (body.enabled === true && body.ids?.length) {
				const channels = await NotificationService.find_enabled_channels(body.ids);
				const scoped = channels.filter((ch) => ch.realm_id === realm_id);
				res.json({ ok: true, channels: scoped });
				return;
			}
			const channels = await NotificationService.list_channels({
				realm_id,
				query: body.query,
			});
			if (body.enabled === true) {
				res.json({ ok: true, channels: channels.filter((ch) => ch.enabled) });
				return;
			}
			res.json({ ok: true, channels });
		} catch (err) { next(err); }
	}

	static async channels_create(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = require_authenticated_user_id(req);
			const org_id = req.user?.current_org_id;
			const data = channels_create_schema.parse(req.body);
			const realm_id = data.realm_id?.trim();

			if (data.destinations) {
				await detect_channel_ref_cycles(data.name, data.destinations, realm_id ?? null);
			}

			if (realm_id) {
				await require_realm_notification_admin(realm_id, user_id, req);
			} else {
				await require_account_notification_admin(req);
			}

			const channel = await NotificationService.create_channel({
				realm_id: realm_id ?? null,
				org_id: realm_id ? null : (org_id ?? null),
				name: data.name,
				destinations: data.destinations,
				enabled: data.enabled,
			});
			res.json({ ok: true, channel });
		} catch (err) { next(err); }
	}

	static async channels_update(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = require_authenticated_user_id(req);
			const data = channels_update_schema.parse(req.body);
			const existing = await NotificationService.get_channel(data.id);
			await assert_channel_in_org(existing, req.user?.current_org_id);
			if (existing.realm_id) {
				await require_realm_notification_admin(existing.realm_id, user_id, req);
			}
			if (!existing.realm_id) {
				/** Allow users to edit their own personal channel without admin. */
				if (!existing.user_id || String(existing.user_id) !== user_id) {
					await require_account_notification_admin(req);
				}
			}

			if (data.destinations) {
				const channel_name = data.name ?? existing.name;
				await detect_channel_ref_cycles(
					channel_name,
					data.destinations,
					existing.realm_id,
				);
			}

			const channel = await NotificationService.update_channel(data);
			res.json({ ok: true, channel });
		} catch (err) { next(err); }
	}

	static async channels_remove(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = require_authenticated_user_id(req);
			const { id } = channels_remove_schema.parse(req.body);
			const existing = await NotificationService.get_channel(id);
			await assert_channel_in_org(existing, req.user?.current_org_id);
			if (existing.realm_id) {
				await require_realm_notification_admin(existing.realm_id, user_id, req);
			}
			if (!existing.realm_id) {
				/** Allow users to delete their own personal channel without admin. */
				if (!existing.user_id || String(existing.user_id) !== user_id) {
					await require_account_notification_admin(req);
				}
			}
			const removed = await NotificationService.remove_channel(id);
			res.json({ ok: true, removed });
		} catch (err) { next(err); }
	}

	/** POST /v1/notification_channels/test — fire a synthetic test through the channel. */
	static async channels_test(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = require_authenticated_user_id(req);
			const { id, destination_index } = channels_test_schema.parse(req.body);
			const channel = await NotificationService.get_channel(id);
			await assert_channel_in_org(channel, req.user?.current_org_id);

			if (channel.realm_id) {
				await require_realm_notification_admin(channel.realm_id, user_id, req);
			}
			if (!channel.realm_id) {
				/** Allow personal channel owners to test without admin. */
				if (!channel.user_id || String(channel.user_id) !== user_id) {
					await require_account_notification_admin(req);
				}
			}

			const { delivered, errors } = await NotificationService.test_channel(id, destination_index);
			res.json({ ok: true, delivered, errors });
		} catch (err) { next(err); }
	}

	// ── Rules (served under /v1/orgs/* and /v1/realms/*) ─────────────

	/** List rules at org tier (no realm_id) or realm/team tier. */
	static async rules_list(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = require_authenticated_user_id(req);
			const org_id = req.user?.current_org_id;
			const body = rules_list_schema.parse(req.body ?? {});
			const realm_id = body.realm_id?.trim();

			if (realm_id) {
				await require_realm_notification_member(realm_id, user_id);
				if (body.effective) {
					const rules = await NotificationService.list_effective_rules(realm_id, org_id);
					res.json({ ok: true, rules });
					return;
				}
				const rules = await NotificationService.list_rules({
					realm_id,
					team_slug: body.team_slug,
				});
				res.json({ ok: true, rules });
				return;
			}

			const rules = await NotificationService.list_rules({ org_id });
			res.json({ ok: true, rules });
		} catch (err) { next(err); }
	}

	/** Create or update a rule at org or realm/team tier. */
	static async rules_set(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = require_authenticated_user_id(req);
			const org_id = req.user?.current_org_id;
			const data = rules_set_schema.parse(req.body);
			const realm_id = data.realm_id?.trim();

			if (realm_id) {
				await require_realm_notification_admin(realm_id, user_id, req);
			}
			if (!realm_id) {
				await require_account_notification_admin(req);
			}

			const rule = await NotificationService.set_rule({
				realm_id: realm_id || null,
				org_id: realm_id ? null : (org_id ?? null),
				team_slug: data.team_slug || null,
				event: data.event,
				channel_id: data.channel_id,
				priority: data.priority,
			});
			res.json({ ok: true, rule });
		} catch (err) { next(err); }
	}

	/** Delete a rule by ID. */
	static async rules_remove(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			require_authenticated_user_id(req);
			const { id } = rules_remove_schema.parse(req.body);
			const removed = await NotificationService.remove_rule(id);
			res.json({ ok: true, removed });
		} catch (err) { next(err); }
	}

	/** POST /v1/notifications/get — in-app inbox rows for caller. */
	static async inbox_get(req: Request, res: Response, next: NextFunction): Promise<void> {
		try {
			const user_id = require_authenticated_user_id(req);
			const body = inbox_list_schema.parse(req.body ?? {});
			const result = await InAppNotificationService.list_for_user({
				user_id,
				realm_id: body?.realm_id,
				org_id: req.user?.current_org_id,
				realms: body?.realms,
				types: body?.types,
				severities: body?.severities,
				teams: body?.teams,
				run_id: body?.run_id,
				phases: body?.phases,
				q: body?.q,
				since_ms: body?.since_ms,
				until_ms: body?.until_ms,
				initiated_by_me: body?.initiated_by_me,
				limit: body?.limit,
				offset: body?.offset,
			});
			res.json({
				ok: true,
				notifications: result.notifications,
				total: result.total,
				offset: body?.offset ?? 0,
				limit: body?.limit ?? 50,
			});
		} catch (err) { next(err); }
	}
}


// ---------------------------------------------------------------------------
// Cycle detection for channel_ref destinations
// ---------------------------------------------------------------------------

import type { Destination } from '../notifications/channel_config.js';

/**
 * DFS cycle detection for `channel_ref` destinations.
 *
 * Walks the reference graph starting from `channel_name`. If any
 * `channel_ref` destination eventually points back to `channel_name`
 * (directly or transitively), throws `ApiError.bad_request`.
 */
async function detect_channel_ref_cycles(
	channel_name: string,
	destinations: Destination[],
	realm_id: string | null,
): Promise<void> {
	const refs = destinations
		.filter((d): d is Destination & { type: 'channel_ref' } => d.type === 'channel_ref')
		.map((d) => d.name);
	if (refs.length === 0) return;

	const visited = new Set<string>([channel_name]);

	async function walk(ref_name: string, path: string[]): Promise<void> {
		if (visited.has(ref_name)) {
			throw ApiError.bad_request(
				`Channel reference cycle detected: ${[...path, ref_name].join(' → ')}`,
			);
		}
		visited.add(ref_name);

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
			await walk(child_ref, [...path, ref_name]);
		}
	}

	for (const ref of refs) {
		await walk(ref, [channel_name]);
	}
}
