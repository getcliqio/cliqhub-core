import { describe, it, expect } from 'vitest';

import { get_deliverer, DELIVERER_BY_PROVIDER } from '../../../src/notifications/deliverers/index.js';
import { CHANNEL_PROVIDERS } from '../../../src/notifications/types.js';

describe('DELIVERER_BY_PROVIDER', () => {
	it('registers every ChannelProvider', () => {
		for (const provider of CHANNEL_PROVIDERS) {
			expect(DELIVERER_BY_PROVIDER[provider].provider).toBe(provider);
			expect(get_deliverer(provider).provider).toBe(provider);
		}
	});

	it('rejects unknown provider', () => {
		expect(() => get_deliverer('pagerduty')).toThrow(/Unknown notification provider/);
	});
});
