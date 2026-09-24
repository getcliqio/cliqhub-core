import { describe, it, expect } from 'vitest';

import {
	EVENT_TYPES,
	is_event_type,
	EVENT_TYPE_SEVERITY,
} from '../../../src/events/types.js';

describe('event types catalog', () => {
	it('includes core run, phase, hug, team, daemon, realm types', () => {
		expect(EVENT_TYPES).toContain('run.started');
		expect(EVENT_TYPES).toContain('phase.timed_out');
		expect(EVENT_TYPES).toContain('hug.review_requested');
		expect(EVENT_TYPES).toContain('hug.routing_requested');
		expect(EVENT_TYPES).toContain('hug.review_responded');
		expect(EVENT_TYPES).toContain('team.published');
		expect(EVENT_TYPES).toContain('daemon.removed');
		expect(EVENT_TYPES).toContain('realm.key_rotated');
		expect(EVENT_TYPES).toContain('notification.test');
	});

	it('includes daemon.outbox.{dead,recovered} for outbox-stuck alerting', () => {
		// The daemon's local outbox emits these when its dead-count
		// transitions across zero — they're the alerting channel that
		// tells operators to open the Hub outbox card.
		expect(EVENT_TYPES).toContain('daemon.outbox.dead');
		expect(EVENT_TYPES).toContain('daemon.outbox.recovered');
		expect(EVENT_TYPE_SEVERITY['daemon.outbox.dead']).toBe('error');
		expect(EVENT_TYPE_SEVERITY['daemon.outbox.recovered']).toBe('info');
	});

	it('includes phase.idle (notify-only idle watchdog, severity warn)', () => {
		expect(EVENT_TYPES).toContain('phase.idle');
		expect(is_event_type('phase.idle')).toBe(true);
		expect(EVENT_TYPE_SEVERITY['phase.idle']).toBe('warn');
	});

	it('rejects unknown and legacy stuck / yanked names', () => {
		expect(is_event_type('run.started')).toBe(true);
		expect(is_event_type('phase.stuck')).toBe(false);
		expect(is_event_type('team.yanked')).toBe(false);
		expect(is_event_type('daemon.key_rotated')).toBe(false);
		expect(is_event_type('on_complete')).toBe(false);
		expect(is_event_type('')).toBe(false);
	});

	it('rejects underscored daemon legacy lifecycle strings', () => {
		// Yamazaki: Hub accepts catalog names only — no coerce/alias.
		expect(is_event_type('phase_start')).toBe(false);
		expect(is_event_type('phase_awaiting_input')).toBe(false);
		expect(is_event_type('run_started')).toBe(false);
		expect(is_event_type('on_phase_stuck')).toBe(false);
	});

	it('has a severity default for every catalog type', () => {
		for (const type of EVENT_TYPES) {
			expect(EVENT_TYPE_SEVERITY[type]).toBeTruthy();
		}
	});
});
