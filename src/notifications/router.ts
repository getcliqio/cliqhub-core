import { NotificationFanOutService } from './fan_out.service.js';
import type { SubmittedEvent } from '../services/events_service.js';
import type { NotificationDispatchStatus } from './types.js';

/**
 * Route a submitted event to the appropriate fan-out path.
 *
 * Realm-scoped events (run / phase / hug / daemon / realm / custom) go to
 * `notify_realm`. Account-scoped events (team / auth) go to `notify_account`.
 * `notification.test` and `notification.failed` pick the realm path when a
 * realm_id is present, account path otherwise.
 */
export async function route_event(event: SubmittedEvent): Promise<NotificationDispatchStatus> {
	return is_realm_event(event)
		? NotificationFanOutService.notify_realm(event)
		: NotificationFanOutService.notify_account(event);
}

function is_realm_event(event: SubmittedEvent): boolean {
	const t = event.type;
	if (
		t.startsWith('run.') ||
		t.startsWith('phase.') ||
		t.startsWith('hug.') ||
		t.startsWith('daemon.') ||
		t.startsWith('realm.') ||
		t.startsWith('custom.')
	) return true;

	if (t === 'notification.test' || t === 'notification.failed') {
		return !!event.realm_id?.trim();
	}

	// Always about a realm: its fixed rule sends it to the realm's All realm members.
	if (t === 'notification.unknown_channel') return true;

	if (t.startsWith('team.') || t.startsWith('auth.')) return false;

	throw new Error(`No notification route for event type '${t}'`);
}
