/**
 * Unknown channel — a channel named for an event doesn't exist (PLAN-notifications-v2 B2/B3).
 *
 * A run's notify channels and a gate's reviewers are channel names; teams are written offline and names
 * can arrive as run-time inputs, so a missing name can't always be stopped up front. When one is met, the
 * channels that exist still deliver and CliqHub raises `notification.unknown_channel` for each missing
 * name. It goes wherever the org or realm sends it (nothing by default since 2026-10-22). Raised once per
 * run per name, so a run's several lifecycle events don't repeat the same notice.
 */
import { get_logger } from '../lib/log.js';
import { HubEvent } from '../models/index.js';

const log = get_logger('notify.unknown_channel');

/** Where the missing name came from. */
export type UnknownChannelSource = 'notify_channels' | 'reviewers';

export interface UnknownChannelInput {
	realm_id: string;
	/** The missing channel name, as written; null when the phase names no channel at all. */
	name: string | null;
	source: UnknownChannelSource;
	/** The event that named it (e.g. run.failed, hug.opened). */
	for_event: string;
	run_id?: string | null;
	phase?: string | null;
	team?: string | null;
	daemon_id?: string | null;
}

/** The notice's message — also what identifies a repeat for the same run and name. */
export function unknown_channel_message(name: string): string {
	return `No channel named '${name}' in this realm — nothing was sent to it.`;
}

/** The notice's message when a phase asks a person but names no channel (PLAN-notifications-v2 B4.3). */
export function no_channel_message(phase: string | null | undefined): string {
	return `Phase '${phase ?? '?'}' asked a person but names no hug channel — nothing was sent.`;
}

/**
 * Raise `notification.unknown_channel` for one missing name (once per run per name). Never throws:
 * a failure to raise is logged and the caller carries on.
 */
export async function raise_unknown_channel(input: UnknownChannelInput): Promise<void> {
	const message = input.name === null ? no_channel_message(input.phase) : unknown_channel_message(input.name);
	try {
		if (input.run_id) {
			const already = await HubEvent.findOne({ where: { type: 'notification.unknown_channel', run_id: input.run_id, message }, attributes: ['id'], raw: true });
			if (already) return;
		}
		const { EventSubmitService } = await import('../services/events_service.js');
		await EventSubmitService.submit({
			type: 'notification.unknown_channel',
			realm_id: input.realm_id,
			run_id: input.run_id ?? undefined,
			phase: input.phase ?? undefined,
			team: input.team ?? undefined,
			daemon_id: input.daemon_id ?? undefined,
			severity: 'warn',
			title: input.name === null ? 'No hug channel' : `Unknown channel: ${input.name}`,
			message,
			payload: { name: input.name, source: input.source, for_event: input.for_event } as never,
		}, { system: true });
		log.info('unknown_channel_raised', { realm_id: input.realm_id, run_id: input.run_id ?? null, source: input.source, for_event: input.for_event });
	} catch (err) {
		log.error('unknown_channel_raise_failed', { realm_id: input.realm_id, error: err instanceof Error ? err.message : String(err) });
	}
}
