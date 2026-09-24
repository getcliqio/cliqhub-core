/**
 * RunEventBus — in-process pub/sub for run events.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

import {
    publish_run_event,
    subscribe_run_events,
    unsubscribe_run_events,
    subscriber_count,
    type RunEventPayload,
} from '../../../src/services/run_event_bus.js';

function make_event(overrides?: Partial<RunEventPayload>): RunEventPayload {
    return {
        id: hub_legacy_uuid(1),
        run_id: 'run-1',
        event_type: 'llm_output',
        phase: 'coder',
        agent: 'llm-coder',
        payload: { text: 'hello' },
        timestamp: Date.now(),
        ...overrides,
    };
}

describe('RunEventBus', () => {
    const _listeners: Array<{ run_id: string; fn: (e: RunEventPayload) => void }> = [];

    /** Subscribe and track for cleanup. */
    function tracked_subscribe(run_id: string, fn: (e: RunEventPayload) => void): void {
        subscribe_run_events(run_id, fn);
        _listeners.push({ run_id, fn });
    }

    afterEach(() => {
        for (const { run_id, fn } of _listeners) {
            unsubscribe_run_events(run_id, fn);
        }
        _listeners.length = 0;
    });

    it('subscriber receives published event for the same run', () => {
        const received: RunEventPayload[] = [];
        tracked_subscribe('run-1', (e) => received.push(e));

        const event = make_event();
        publish_run_event(event);

        expect(received).toHaveLength(1);
        expect(received[0]!.event_type).toBe('llm_output');
    });

    it('two subscribers on same run both receive the event', () => {
        const received_a: RunEventPayload[] = [];
        const received_b: RunEventPayload[] = [];
        tracked_subscribe('run-1', (e) => received_a.push(e));
        tracked_subscribe('run-1', (e) => received_b.push(e));

        publish_run_event(make_event());

        expect(received_a).toHaveLength(1);
        expect(received_b).toHaveLength(1);
    });

    it('publish to run_id with no subscribers does not error', () => {
        expect(() => {
            publish_run_event(make_event({ run_id: 'run-nobody' }));
        }).not.toThrow();
    });

    it('unsubscribed listener no longer receives events', () => {
        const received: RunEventPayload[] = [];
        const fn = (e: RunEventPayload) => received.push(e);
        subscribe_run_events('run-1', fn);

        publish_run_event(make_event());
        expect(received).toHaveLength(1);

        unsubscribe_run_events('run-1', fn);
        publish_run_event(make_event({ id: hub_legacy_uuid(2) }));
        expect(received).toHaveLength(1);
    });

    it('subscriber_count tracks listeners correctly', () => {
        expect(subscriber_count('run-count')).toBe(0);

        const fn1 = vi.fn();
        const fn2 = vi.fn();
        tracked_subscribe('run-count', fn1);
        expect(subscriber_count('run-count')).toBe(1);

        tracked_subscribe('run-count', fn2);
        expect(subscriber_count('run-count')).toBe(2);

        unsubscribe_run_events('run-count', fn1);
        _listeners.splice(_listeners.findIndex((l) => l.fn === fn1), 1);
        expect(subscriber_count('run-count')).toBe(1);
    });

    it('events for different runs are isolated', () => {
        const received_1: RunEventPayload[] = [];
        const received_2: RunEventPayload[] = [];
        tracked_subscribe('run-1', (e) => received_1.push(e));
        tracked_subscribe('run-2', (e) => received_2.push(e));

        publish_run_event(make_event({ run_id: 'run-1' }));
        publish_run_event(make_event({ run_id: 'run-2', event_type: 'gate_decision' }));

        expect(received_1).toHaveLength(1);
        expect(received_1[0]!.event_type).toBe('llm_output');
        expect(received_2).toHaveLength(1);
        expect(received_2[0]!.event_type).toBe('gate_decision');
    });
});
