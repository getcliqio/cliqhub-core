import type { SubmittedEvent } from '../../events/submit.service.js';
import type { EventType } from '../../events/types.js';
import type { NotificationDispatchStatus } from '../types.js';
import { NotificationFanOutService } from '../fan_out.service.js';
import { AbstractNotificationHandler } from './abstract_notification_handler.js';
import { get_logger } from '../../lib/log.js';

const log = get_logger('notify.phase');

/** Realm bindings: run / phase / hug / daemon / realm. */
abstract class RealmScopedHandler extends AbstractNotificationHandler {
	constructor(readonly event_type: EventType) {
		super();
	}

	async handle(event: SubmittedEvent): Promise<NotificationDispatchStatus> {
		return NotificationFanOutService.notify_realm(event);
	}
}

/** Account bindings: team / auth. */
abstract class AccountScopedHandler extends AbstractNotificationHandler {
	constructor(readonly event_type: EventType) {
		super();
	}

	async handle(event: SubmittedEvent): Promise<NotificationDispatchStatus> {
		return NotificationFanOutService.notify_account(event);
	}
}

export class RunEventHandler extends RealmScopedHandler {}
export class PhaseEventHandler extends RealmScopedHandler {
	override async handle(event: SubmittedEvent): Promise<NotificationDispatchStatus> {
		if (event.type === 'phase.input_required') {
			await maybe_create_input_pause_review(event).catch((err) => {
				log.warn(
					`input_pause review skipped: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}
		return NotificationFanOutService.notify_realm(event);
	}
}

async function maybe_create_input_pause_review(event: SubmittedEvent): Promise<void> {
	const realm_id = event.realm_id?.trim();
	const run_id = event.run_id?.trim();
	const daemon_id = event.daemon_id?.trim();
	if (!realm_id || !run_id || !daemon_id) return;

	const { HugReviewsService } = await import('../../services/hug_reviews.service.js');
	const bundle = event.payload ?? {};
	const fields = Array.isArray(bundle.fields) ? bundle.fields : [];
	await HugReviewsService.create({
		run_id,
		daemon_id,
		realm_id,
		org_id: event.org_id ? String(event.org_id) : null,
		timeout_minutes: 24 * 60,
		mode: 'input_pause',
		payload: {
			event: 'phase.input_required',
			phase: event.phase,
			team: event.team,
			kind: bundle.kind ?? 'requested_inputs',
			summary: bundle.summary ?? event.message ?? event.title,
			context: bundle.context,
			fields,
			artifacts: bundle.artifacts,
			inputs_schema: fields,
		},
	});
}
export class HugEventHandler extends RealmScopedHandler {}
export class DaemonEventHandler extends RealmScopedHandler {}
export class RealmEventHandler extends RealmScopedHandler {}

export class TeamEventHandler extends AccountScopedHandler {}
export class AuthEventHandler extends AccountScopedHandler {}

/** Realm if realm_id present, otherwise account. */
export class NotificationTestHandler extends AbstractNotificationHandler {
	constructor(readonly event_type: EventType = 'notification.test') {
		super();
	}

	async handle(event: SubmittedEvent): Promise<NotificationDispatchStatus> {
		if (event.realm_id?.trim()) {
			return NotificationFanOutService.notify_realm(event);
		}
		return NotificationFanOutService.notify_account(event);
	}
}

/** Custom events are always realm-scoped. */
export class CustomEventHandler extends RealmScopedHandler {}

/** notification.failed: route to realm if realm_id is present, else account. */
export class NotificationFailedHandler extends AbstractNotificationHandler {
	constructor(readonly event_type: EventType = 'notification.failed') {
		super();
	}

	async handle(event: SubmittedEvent): Promise<NotificationDispatchStatus> {
		if (event.realm_id?.trim()) {
			return NotificationFanOutService.notify_realm(event);
		}
		return NotificationFanOutService.notify_account(event);
	}
}

export function create_handler_for_type(type: EventType | string): AbstractNotificationHandler {
	if (type === 'notification.test') return new NotificationTestHandler(type as EventType);
	if (type === 'notification.failed') return new NotificationFailedHandler();
	if (type.startsWith('run.')) return new RunEventHandler(type as EventType);
	if (type.startsWith('phase.')) return new PhaseEventHandler(type as EventType);
	if (type.startsWith('hug.')) return new HugEventHandler(type as EventType);
	if (type.startsWith('daemon.')) return new DaemonEventHandler(type as EventType);
	if (type.startsWith('realm.')) return new RealmEventHandler(type as EventType);
	if (type.startsWith('team.')) return new TeamEventHandler(type as EventType);
	if (type.startsWith('auth.')) return new AuthEventHandler(type as EventType);
	if (type.startsWith('custom.')) return new CustomEventHandler(type as EventType);
	throw new Error(`No notification handler for event type '${type}'`);
}
