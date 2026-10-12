/**
 * Yamazaki H3.3 — notify intent → fan-out plan (pure).
 */
import { describe, it, expect } from 'vitest';
import {
	plan_fan_out,
	read_notify_channels_intent,
} from '../../../src/notifications/notify_intent.js';

describe('notify_intent', () => {
	it('reads payload.notify.channels', () => {
		expect(read_notify_channels_intent(undefined)).toBeUndefined();
		expect(read_notify_channels_intent({ notify: { channels: false } })).toBe(false);
		expect(read_notify_channels_intent({ notify: { channels: [] } })).toEqual([]);
		expect(read_notify_channels_intent({ notify: { channels: ['slack:ops'] } }))
			.toEqual(['slack:ops']);
	});

	it('plans mute / refs / rules — no hidden all-users fallback', () => {
		expect(plan_fan_out(false)).toEqual({ action: 'mute' });
		expect(plan_fan_out(['a'])).toEqual({ action: 'refs', refs: ['a'] });
		// Absent or [] → the realm's rules (its defaults are ordinary rules on "All realm members").
		expect(plan_fan_out([])).toEqual({ action: 'rules' });
		expect(plan_fan_out(undefined)).toEqual({ action: 'rules' });
	});
});
