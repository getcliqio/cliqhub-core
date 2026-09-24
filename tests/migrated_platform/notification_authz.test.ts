import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hash'),
    verify_password: vi.fn().mockResolvedValue(true),
}));
import request from 'supertest';

import { create_migrated_test_app } from './helpers/test_app.js';
import {
	close_test_control_plane_store,
	open_test_control_plane_store,
	postgres_reachable,
} from './helpers/control_plane_store.js';
import { make_hub_bearer, stub_hub_pat_auth } from './helpers/hub_jwt.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import {
	NotificationChannel,
	Realm,
	RealmMember,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const { app, repos } = create_migrated_test_app();
const uid = () => `authz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function mock_user(id: number, role: 'user' | 'admin' = 'user') {
	stub_hub_pat_auth(repos);
	const user_id = hub_legacy_uuid(id);
	repos.user_repo.find_by_id.mockResolvedValue({
		id: user_id,
		username: `user-${id}`,
		display_name: `User ${id}`,
		email: `user${id}@test.local`,
		role,
		suspended_at: null,
		suspended_reason: '',
		created_at: new Date().toISOString(),
	});
}

describe.skipIf(!has_postgres)('Notification AuthZ', () => {
	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
	});

	beforeEach(async () => {
		if (!has_postgres) return;
		await NotificationChannel.destroy({ where: {} });
		await RealmMember.destroy({ where: {} });
		await Realm.destroy({ where: {} });
		mock_user(1, 'user');
	});

	afterAll(async () => {
		if (!has_postgres) return;
		await close_test_control_plane_store();
	});

	it('realm-scoped slack channel create succeeds for realm admin', async () => {
		mock_user(1, 'user');
		const realm = await RealmService.create(hub_legacy_uuid(1), `a-${uid()}`.slice(0, 40), 'Authz');

		await RealmMember.update(
			{ role: 'admin' },
			{ where: { realm_id: realm.id, member_id: hub_legacy_uuid(1) } },
		);
		const res = await request(app)
			.post('/v1/notification_channels/create')
			.set('Authorization', make_hub_bearer({ user_id: hub_legacy_uuid(1), role: 'user', org_ids: [] }))
			.send({
				realm_id: realm.id,
				name: uid(),
				destinations: [{ type: 'slack', webhook_url: 'https://hooks.slack.com/services/T/B/X' }],
			});
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		expect(res.body.channel.realm_id).toBe(realm.id);
	});

	it('channel create allowed for hub admin as account channel', async () => {
		mock_user(1, 'admin');
		const res = await request(app)
			.post('/v1/notification_channels/create')
			.set('Authorization', make_hub_bearer({ user_id: hub_legacy_uuid(1), role: 'admin' }))
			.send({
				name: uid(),
				destinations: [{ type: 'slack', webhook_url: 'https://hooks.slack.com/services/T/B/X' }],
			});
		expect(res.status).toBe(200);
		expect(res.body.ok).toBe(true);
		expect(res.body.channel.realm_id).toBeNull();
	});

});
