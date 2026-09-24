/**
 * Yamazaki H3.3 — notify intent → fan-out plan (pure).
 */
import { describe, it, expect } from 'vitest';
import {
	is_default_notify_event,
	plan_fan_out,
	read_notify_channels_intent,
} from '../../../src/notifications/notify_intent.js';

describe('notify_intent', () => {
	it('recognizes default-notify set', () => {
		expect(is_default_notify_event('phase.idle')).toBe(true);
		expect(is_default_notify_event('phase.started')).toBe(false);
	});

	it('reads payload.notify.channels', () => {
		expect(read_notify_channels_intent(undefined)).toBeUndefined();
		expect(read_notify_channels_intent({ notify: { channels: false } })).toBe(false);
		expect(read_notify_channels_intent({ notify: { channels: [] } })).toEqual([]);
		expect(read_notify_channels_intent({ notify: { channels: ['slack:ops'] } }))
			.toEqual(['slack:ops']);
	});

	it('plans mute / refs / all_users / rules', () => {
		expect(plan_fan_out('phase.idle', false)).toEqual({ action: 'mute' });
		expect(plan_fan_out('phase.idle', ['a'])).toEqual({ action: 'refs', refs: ['a'] });
		expect(plan_fan_out('phase.idle', [])).toEqual({ action: 'all_users' });
		expect(plan_fan_out('phase.idle', undefined)).toEqual({ action: 'all_users' });
		expect(plan_fan_out('phase.started', undefined)).toEqual({ action: 'rules' });
		expect(plan_fan_out('phase.started', [])).toEqual({ action: 'rules' });
	});
});
