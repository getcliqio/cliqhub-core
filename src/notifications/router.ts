import { get_logger } from '../lib/log.js';
import { NotificationFanOutService } from './fan_out.service.js';
import type { SubmittedEvent } from '../services/events_service.js';
import type { NotificationDispatchStatus } from './types.js';

const log = get_logger('notify.router');

/**
 * Route a submitted event to the appropriate fan-out path.
 *
 * Realm-scoped events (run / phase / hug / daemon / realm / custom) go to
 * `notify_realm`. Account-scoped events (team / auth) go to `notify_account`.
 * `notification.test` and `notification.failed` pick the realm path when a
 * realm_id is present, account path otherwise.
 */
export async function route_event(event: SubmittedEvent): Promise<NotificationDispatchStatus> {
	if (event.type === 'phase.input_required') {
		await maybe_create_input_pause_review(event).catch((err) => {
			log.warn(`input_pause review skipped: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

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

	if (t.startsWith('team.') || t.startsWith('auth.')) return false;

	throw new Error(`No notification route for event type '${t}'`);
}

async function maybe_create_input_pause_review(event: SubmittedEvent): Promise<void> {
	const realm_id = event.realm_id?.trim();
	const run_id = event.run_id?.trim();
	const daemon_id = event.daemon_id?.trim();
	if (!realm_id || !run_id || !daemon_id) return;

	const { HugReviewsService } = await import('../services/hug_reviews.service.js');
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
