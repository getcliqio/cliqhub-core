/**
 * No access — a person a Hug's channels reach may not see it (no `runs.view` on its realm), so nothing
 * was sent to them (PLAN-hug-requests §6.4). Channels carry no permissions; this tells whoever the org
 * or realm routes `notification.no_access` to that a channel reaches someone it shouldn't. Raised once
 * per run per person and channel, so a gate that loops doesn't repeat it.
 */
import { get_logger } from '../lib/log.js';
import { HubEvent } from '../models/index.js';

const log = get_logger('notify.no_access');

export interface NoAccessInput {
	realm_id: string;
	/** The channel name, as the Hug gave it. */
	channel: string;
	/** Who it reached and was not sent to. */
	person: { user_id: string; name: string };
	/** The event that was not sent (e.g. hug.opened). */
	for_event: string;
	run_id?: string | null;
	phase?: string | null;
	daemon_id?: string | null;
}

/** The notice's message — also what identifies a repeat for the same run. */
export function no_access_message(channel: string, name: string): string {
	return `'${channel}' reaches ${name}, who can't view runs in this realm — nothing was sent to them.`;
}

/** Raise `notification.no_access` (once per run per person and channel). Never throws. */
export async function raise_no_access(input: NoAccessInput): Promise<void> {
	const message = no_access_message(input.channel, input.person.name);
	try {
		if (input.run_id) {
			const already = await HubEvent.findOne({ where: { type: 'notification.no_access', run_id: input.run_id, message }, attributes: ['id'], raw: true });
			if (already) return;
		}
		const { EventSubmitService } = await import('../services/events_service.js');
		await EventSubmitService.submit({
			type: 'notification.no_access',
			realm_id: input.realm_id,
			run_id: input.run_id ?? undefined,
			phase: input.phase ?? undefined,
			daemon_id: input.daemon_id ?? undefined,
			severity: 'warn',
			title: `Not sent to ${input.person.name}: no access`,
			message,
			payload: { channel: input.channel, user_id: input.person.user_id, name: input.person.name, for_event: input.for_event } as never,
		}, { system: true });
		log.info('no_access_raised', { realm_id: input.realm_id, run_id: input.run_id ?? null, channel: input.channel });
	} catch (err) {
		log.error('no_access_raise_failed', { realm_id: input.realm_id, error: err instanceof Error ? err.message : String(err) });
	}
}
