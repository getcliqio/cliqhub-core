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
import { InAppNotificationService } from '../../src/services/in_app_notification.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import {
	InAppNotification,
	Realm,
	RealmMember,
} from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const { app, repos } = create_migrated_test_app();
const uid = () => `nlist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('POST /v1/notifications/get', () => {
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

	beforeEach(async () => {
		if (!has_postgres) return;
		await InAppNotification.destroy({ where: {} });
		await RealmMember.destroy({ where: {} });
		await Realm.destroy({ where: {} });
	});

	afterAll(async () => {
		if (!has_postgres) return;
		await InAppNotification.destroy({ where: {} });
		await close_test_control_plane_store();
	});

	it('requires auth', async () => {
		const res = await request(app).post('/v1/notifications/get').send({});
		expect(res.status).toBe(401);
	});

	it('member sees realm-scoped row; non-member does not', async () => {
		const realm = await RealmService.create(hub_legacy_uuid(1), `nl-${uid()}`.slice(0, 40), 'List Realm');
		await InAppNotificationService.create_from_payload({
			event: 'run.failed',
			message: 'member-visible',
			realm_id: realm.id,
			run_id: 'run-1',
		});

		const member_res = await request(app)
			.post('/v1/notifications/get')
			.set('Authorization', make_hub_bearer({ user_id: hub_legacy_uuid(1) }))
			.send({});
		expect(member_res.status).toBe(200);
		expect(member_res.body.ok).toBe(true);
		expect(member_res.body.notifications).toHaveLength(1);
		expect(member_res.body.notifications[0].message).toBe('member-visible');

		const outsider = await InAppNotificationService.list_for_user({
			user_id: hub_legacy_uuid(99),
		});
		expect(outsider.notifications.filter((r) => r.realm_id === realm.id)).toHaveLength(0);
	});

	it('account-scoped rows visible to any authenticated user', async () => {
		await InAppNotificationService.create_from_payload({
			event: 'team.published',
			message: 'account-wide',
			team_slug: '@acme/demo',
		});

		const rows = await InAppNotificationService.list_for_user({ user_id: hub_legacy_uuid(42) });
		expect(rows.notifications).toHaveLength(1);
		expect(rows.notifications[0].realm_id).toBeNull();
		expect(rows.notifications[0].event).toBe('team.published');
	});

	it('filters by realm_id and types; empty when not a member of filter realm', async () => {
		const realm_a = await RealmService.create(hub_legacy_uuid(1), `a-${uid()}`.slice(0, 40), 'A');
		const realm_b = await RealmService.create(hub_legacy_uuid(2), `b-${uid()}`.slice(0, 40), 'B');
		await InAppNotificationService.create_from_payload({
			event: 'run.failed',
			realm_id: realm_a.id,
			message: 'a-fail',
		});
		await InAppNotificationService.create_from_payload({
			event: 'hug.review_requested',
			realm_id: realm_a.id,
			message: 'a-hug',
		});
		await InAppNotificationService.create_from_payload({
			event: 'run.failed',
			realm_id: realm_b.id,
			message: 'b-fail',
		});

		const filtered = await InAppNotificationService.list_for_user({
			user_id: hub_legacy_uuid(1),
			realm_id: realm_a.id,
			types: ['run.failed'],
		});
		expect(filtered.notifications).toHaveLength(1);
		expect(filtered.notifications[0].message).toBe('a-fail');
		expect(filtered.total).toBe(1);

		const not_member = await InAppNotificationService.list_for_user({
			user_id: hub_legacy_uuid(1),
			realm_id: realm_b.id,
		});
		expect(not_member.notifications).toHaveLength(0);
	});

	it('returns empty list when none', async () => {
		const res = await request(app)
			.post('/v1/notifications/get')
			.set('Authorization', make_hub_bearer())
			.send({});
		expect(res.status).toBe(200);
		expect(res.body.notifications).toEqual([]);
	});
});
