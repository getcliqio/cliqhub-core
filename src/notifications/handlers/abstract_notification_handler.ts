import type { SubmittedEvent } from '../../services/events_service.js';
import type { EventType } from '../../schemas/event_types.js';
import type { NotificationDispatchStatus } from '../types.js';

export abstract class AbstractNotificationHandler {
	abstract readonly event_type: EventType;

	abstract handle(event: SubmittedEvent): Promise<NotificationDispatchStatus>;
}
