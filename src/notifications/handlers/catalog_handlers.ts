import { EVENT_TYPES, type EventType } from '../../events/types.js';
import { AbstractNotificationHandler } from './abstract_notification_handler.js';
import { create_handler_for_type } from './family_handlers.js';

/**
 * Lazily-initialized handler cache for the fixed event catalog.
 * Built on first access to avoid TDZ issues from circular imports.
 */
let _handler_cache: Record<string, AbstractNotificationHandler> | null = null;

function ensure_cache(): Record<string, AbstractNotificationHandler> {
	if (!_handler_cache) {
		_handler_cache = Object.fromEntries(
			EVENT_TYPES.map((type) => [type, create_handler_for_type(type)]),
		);
	}
	return _handler_cache;
}

export const HANDLER_BY_EVENT_TYPE: Record<EventType, AbstractNotificationHandler> =
	new Proxy({} as Record<EventType, AbstractNotificationHandler>, {
		get(_target, prop: string) {
			return ensure_cache()[prop];
		},
	});

/**
 * Returns the notification handler for a given event type.
 * For the fixed catalog this is a cached lookup; for `custom.*`
 * events a new handler is created on the fly.
 */
export function get_notification_handler(type: EventType | string): AbstractNotificationHandler {
	const cached = ensure_cache()[type];
	if (cached) return cached;
	return create_handler_for_type(type);
}
