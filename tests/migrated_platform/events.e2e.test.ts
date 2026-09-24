import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hash'),
    verify_password: vi.fn().mockResolvedValue(true),
}));
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { create_migrated_test_app } from './helpers/test_app.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { make_hub_bearer, stub_hub_pat_auth } from './helpers/hub_jwt.js';

const has_postgres = await postgres_reachable();

const { app, repos } = create_migrated_test_app();

describe.skipIf(!has_postgres)('Events endpoints', () => {
	beforeAll(async () => {
    if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
		stub_hub_pat_auth(repos);
		repos.user_repo.find_by_id.mockResolvedValue({
			id: hub_legacy_uuid(1),
			username: 'migrated-platform-user',
			display_name: 'Migrated Platform User',
			email: 'platform@test.local',
			role: 'user',
			suspended_at: null,
			suspended_reason: '',
			created_at: new Date().toISOString(),
		});
	});

	afterAll(async () => {
    if (!has_postgres) return;
		await close_test_control_plane_store();
	});

	it('POST /v1/events/types/list returns catalog', async () => {
		const res = await request(app)
			.post('/v1/events/types/list')
			.set('Authorization', make_hub_bearer())
			.send({});
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		expect(res.body.types).toContain('hug.routing_requested');
		expect(res.body.types).toContain('run.started');
	});

	it('POST /v1/events/submit accepts known type with family-required fields', async () => {
		const res = await request(app)
			.post('/v1/events/submit')
			.set('Authorization', make_hub_bearer())
			.send({
				tx_id: randomUUID(),
				type: 'phase.escalated',
				realm_id: 'realm-e2e',
				run_id: 'run-e2e',
				daemon_id: 'daemon-e2e',
				team: 'acme/demo',
				phase: 'review',
				message: 'needs human',
			});
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		expect(res.body.event.type).toBe('phase.escalated');
		expect(res.body.event.daemon_id).toBe('daemon-e2e');
		expect(res.body.event.notifications).toBe('skipped');

		const get_res = await request(app)
			.post('/v1/events/get_by_id')
			.set('Authorization', make_hub_bearer())
			.send({ id: res.body.event.id });
		expect(get_res.status).toBe(200);
		expect(get_res.body.event.phase).toBe('review');
	});

	it('POST /v1/events/submit rejects unknown type', async () => {
		const res = await request(app)
			.post('/v1/events/submit')
			.set('Authorization', make_hub_bearer())
			.send({ type: 'on_complete' });
		expect(res.status).toBe(400);
	});

	it('POST /v1/events/submit rejects phase.* missing daemon_id', async () => {
		const res = await request(app)
			.post('/v1/events/submit')
			.set('Authorization', make_hub_bearer())
			.send({
				type: 'phase.escalated',
				realm_id: 'realm-e2e',
				run_id: 'run-e2e',
				phase: 'review',
			});
		expect(res.status).toBe(400);
	});

	it('POST /v1/events/submit requires auth', async () => {
		const res = await request(app)
			.post('/v1/events/submit')
			.send({ type: 'notification.test' });
		expect(res.status).toBe(401);
	});
});

