import type { SubmittedEvent } from '../../events/submit.service.js';
import type { EventType } from '../../events/types.js';
import type { NotificationDispatchStatus } from '../types.js';

export abstract class AbstractNotificationHandler {
	abstract readonly event_type: EventType;

	abstract handle(event: SubmittedEvent): Promise<NotificationDispatchStatus>;
}
