import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Sequelize } from 'sequelize';
import { ZodError } from 'zod';

import {
	close_control_plane_store,
	init_control_plane_store,
} from '../../../src/db/control_plane_store.js';
import { EventSubmitService } from '../../../src/events/submit.service.js';
import { HubEvent } from '../../../src/events/event.model.js';

const DATABASE_URL =
	process.env.DATABASE_URL
	?? 'postgresql://cliqhub:cliqhub@localhost:5432/cliqhub';

async function postgres_reachable(): Promise<boolean> {
	const probe = new Sequelize(DATABASE_URL, { dialect: 'postgres', logging: false });
	try {
		await probe.authenticate();
		await probe.close();
		return true;
	} catch {
		try { await probe.close(); } catch { /* ignore */ }
		return false;
	}
}

const has_pg = await postgres_reachable();

describe.skipIf(!has_pg)('EventSubmitService', () => {
	beforeAll(async () => {
		await init_control_plane_store(DATABASE_URL);
	});

	beforeEach(async () => {
		await HubEvent.destroy({ where: {} });
	});

	afterAll(async () => {
		await HubEvent.destroy({ where: {} });
		await close_control_plane_store();
	});

	it('persists run.failed when family-required fields are present', async () => {
		const event = await EventSubmitService.submit({
			type: 'run.failed',
			realm_id: 'realm-1',
			run_id: 'run-1',
			daemon_id: 'daemon-1',
			team: 'acme/pipe',
			message: 'phase blew up',
			payload: { error: 'boom' },
			actor_id: 'user-1',
		});

		expect(event.id).toBeTruthy();
		expect(event.type).toBe('run.failed');
		expect(event.realm_id).toBe('realm-1');
		expect(event.run_id).toBe('run-1');
		expect(event.daemon_id).toBe('daemon-1');
		expect(event.team).toBe('acme/pipe');
		expect(event.severity).toBe('error');
		expect(event.payload).toEqual({ error: 'boom' });
		expect(event.actor_id).toBe('user-1');

		const loaded = await EventSubmitService.get(event.id);
		expect(loaded.type).toBe('run.failed');
		expect(loaded.run_id).toBe('run-1');
	});

	it('rejects run.failed without required fields via Zod', async () => {
		await expect(EventSubmitService.submit({ type: 'run.failed' }))
			.rejects.toBeInstanceOf(ZodError);
	});

	it('rejects unknown types via Zod', async () => {
		await expect(EventSubmitService.submit({ type: 'phase.stuck' }))
			.rejects.toBeInstanceOf(ZodError);
	});

	it('defaults occurred_at and severity from catalog for notification.test', async () => {
		const event = await EventSubmitService.submit({ type: 'notification.test' });
		expect(event.occurred_at).toMatch(/^\d{4}-/);
		expect(event.severity).toBe('info');
	});
});
