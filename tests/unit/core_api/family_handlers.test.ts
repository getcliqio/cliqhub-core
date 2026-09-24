import { describe, it, expect } from 'vitest';

import {
	AuthEventHandler,
	DaemonEventHandler,
	HugEventHandler,
	NotificationTestHandler,
	PhaseEventHandler,
	RealmEventHandler,
	RunEventHandler,
	TeamEventHandler,
	create_handler_for_type,
} from '../../../src/notifications/handlers/family_handlers.js';

describe('create_handler_for_type', () => {
	it('maps families to handler classes', () => {
		expect(create_handler_for_type('run.failed')).toBeInstanceOf(RunEventHandler);
		expect(create_handler_for_type('phase.escalated')).toBeInstanceOf(PhaseEventHandler);
		expect(create_handler_for_type('hug.review_requested')).toBeInstanceOf(HugEventHandler);
		expect(create_handler_for_type('daemon.offline')).toBeInstanceOf(DaemonEventHandler);
		expect(create_handler_for_type('realm.created')).toBeInstanceOf(RealmEventHandler);
		expect(create_handler_for_type('team.published')).toBeInstanceOf(TeamEventHandler);
		expect(create_handler_for_type('auth.api_key_created')).toBeInstanceOf(AuthEventHandler);
		expect(create_handler_for_type('notification.test')).toBeInstanceOf(NotificationTestHandler);
	});
});
