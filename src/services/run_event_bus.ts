/**
 * RunEventBus — in-process pub/sub for run events.
 *
 * The ingest endpoint publishes events here; SSE connections subscribe.
 * Each run_id is a separate channel. Follows the same pattern as the
 * existing span bus used for OTEL span SSE.
 */

import { EventEmitter } from 'node:events';

import { get_logger } from '../lib/log.js';

const log = get_logger('run-event-bus');

/** Shape of an event published on the bus. */
export interface RunEventPayload {
    id: string;
    run_id: string;
    event_type: string;
    phase: string | null;
    agent: string | null;
    payload: unknown;
    timestamp: number;
}

/** Listener function signature. */
export type RunEventListener = (event: RunEventPayload) => void;

const _bus = new EventEmitter();
_bus.setMaxListeners(500);

/**
 * Publish an event to subscribers of a specific run.
 * No-op if no subscribers are listening (events are not queued).
 */
export function publish_run_event(event: RunEventPayload): void {
    _bus.emit(`run:${event.run_id}`, event);
}

/** Subscribe to events for a specific run. */
export function subscribe_run_events(run_id: string, listener: RunEventListener): void {
    _bus.on(`run:${run_id}`, listener);
    log.debug(`subscriber added for run ${run_id}`);
}

/** Unsubscribe from events for a specific run. */
export function unsubscribe_run_events(run_id: string, listener: RunEventListener): void {
    _bus.off(`run:${run_id}`, listener);
    log.debug(`subscriber removed for run ${run_id}`);
}

/** Count of listeners for a run (diagnostic). */
export function subscriber_count(run_id: string): number {
    return _bus.listenerCount(`run:${run_id}`);
}
