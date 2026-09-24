import { describe, it, expect } from 'vitest';

import {
	expand_event_selector,
	is_channel_provider,
	is_event_group,
	is_valid_event_selector,
	normalize_event_selector,
	selectors_matching_event,
} from '../../../src/notifications/types.js';

describe('notification types', () => {
	it('is_channel_provider accepts known providers', () => {
		expect(is_channel_provider('slack')).toBe(true);
		expect(is_channel_provider('email')).toBe(true);
		expect(is_channel_provider('bogus')).toBe(false);
	});

	it('normalizes group aliases', () => {
		expect(normalize_event_selector('run')).toBe('run.*');
		expect(normalize_event_selector('run.*')).toBe('run.*');
		expect(normalize_event_selector('run.failed')).toBe('run.failed');
	});

	it('expand_event_selector expands groups', () => {
		const types = expand_event_selector('run.*');
		expect(types).toContain('run.failed');
		expect(types).toContain('run.started');
		expect(types.every((t) => t.startsWith('run.'))).toBe(true);
	});

	it('expand_event_selector returns single concrete type', () => {
		expect(expand_event_selector('phase.escalated')).toEqual(['phase.escalated']);
	});

	it('expand_event_selector returns empty for unknown', () => {
		expect(expand_event_selector('nope.event')).toEqual([]);
	});

	it('is_valid_event_selector', () => {
		expect(is_valid_event_selector('run.failed')).toBe(true);
		expect(is_valid_event_selector('run')).toBe(true);
		expect(is_valid_event_selector('run.*')).toBe(true);
		expect(is_valid_event_selector('not.a.type')).toBe(false);
		expect(is_event_group('phase.*')).toBe(true);
	});

	it('selectors_matching_event includes type and group', () => {
		const selectors = selectors_matching_event('run.failed');
		expect(selectors).toContain('run.failed');
		expect(selectors).toContain('run.*');
	});
});
