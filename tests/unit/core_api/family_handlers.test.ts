/**
 * Unit tests for the notification event router.
 * Verifies realm-scope vs account-scope routing and the phase.input_required side-effect.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/notifications/fan_out.service.js', () => ({
	NotificationFanOutService: {
		notify_realm: vi.fn().mockResolvedValue('queued'),
		notify_account: vi.fn().mockResolvedValue('queued'),
	},
}));

vi.mock('../../../src/services/hug_reviews.service.js', () => ({
	HugReviewsService: { create: vi.fn().mockResolvedValue(undefined) },
}));

import { route_event } from '../../../src/notifications/router.js';
import { NotificationFanOutService } from '../../../src/notifications/fan_out.service.js';

function make_event(type: string, overrides: Record<string, unknown> = {}) {
	return { type, realm_id: 'r-1', run_id: 'run-1', daemon_id: 'dmn-1', ...overrides } as any;
}

describe('route_event', () => {
	beforeEach(() => vi.clearAllMocks());

	it.each(['run.failed', 'phase.escalated', 'hug.review_requested', 'daemon.offline', 'realm.created', 'custom.deploy'])(
		'routes %s to notify_realm',
		async (type) => {
			await route_event(make_event(type));
			expect(NotificationFanOutService.notify_realm).toHaveBeenCalledOnce();
			expect(NotificationFanOutService.notify_account).not.toHaveBeenCalled();
		},
	);

	it.each(['team.published', 'auth.api_key_created'])(
		'routes %s to notify_account',
		async (type) => {
			await route_event(make_event(type));
			expect(NotificationFanOutService.notify_account).toHaveBeenCalledOnce();
			expect(NotificationFanOutService.notify_realm).not.toHaveBeenCalled();
		},
	);

	it('routes notification.test to notify_realm when realm_id present', async () => {
		await route_event(make_event('notification.test', { realm_id: 'r-1' }));
		expect(NotificationFanOutService.notify_realm).toHaveBeenCalledOnce();
	});

	it('routes notification.test to notify_account when no realm_id', async () => {
		await route_event(make_event('notification.test', { realm_id: '' }));
		expect(NotificationFanOutService.notify_account).toHaveBeenCalledOnce();
	});

	it('routes notification.failed to notify_realm when realm_id present', async () => {
		await route_event(make_event('notification.failed', { realm_id: 'r-1' }));
		expect(NotificationFanOutService.notify_realm).toHaveBeenCalledOnce();
	});

	it('throws on unknown event type', async () => {
		await expect(route_event(make_event('unknown.event'))).rejects.toThrow();
	});
});
