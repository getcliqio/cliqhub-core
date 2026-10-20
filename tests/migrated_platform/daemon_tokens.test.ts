/**
 * PLAN-tokens-sessions step 2 — one token per daemon. A daemon enrolling sends its id; its earlier tokens
 * (made by the same person) are revoked as the new one is made. Tokens made on purpose (no daemon id, shared
 * by several daemons), other daemons' and other people's are left alone. A daemon token records its use.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

vi.mock('../../src/auth/password.js', () => ({
	hash_password: vi.fn().mockResolvedValue('hash'),
	verify_password: vi.fn().mockResolvedValue(true),
}));

import {
	close_test_control_plane_store,
	open_test_control_plane_store,
	postgres_reachable,
} from './helpers/control_plane_store.js';
import { RealmService } from '../../src/services/realm.service.js';
import { ApiToken, Realm, RealmMember, User } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();
const OWNER = hub_legacy_uuid(1);
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe.skipIf(!has_postgres)('one token per daemon', () => {
	const realms: string[] = [];
	const users: string[] = [];
	let realm_id: string;
	let other_user: string;

	beforeAll(async () => {
		if (!has_postgres) return;
		process.env.CLIQ_BFF_LOG_LEVEL = 'error';
		await open_test_control_plane_store();
		const realm = await RealmService.create(OWNER, `dt-${uid()}`.slice(0, 40), 'Daemon tokens');
		realm_id = realm.id;
		realms.push(realm_id);
		const u = await User.create({ username: `dt${uid()}`.slice(0, 20), email: `${randomUUID()}@dt.test`, display_name: 'o', role: 'user', status: 'active', password_hash: null } as never);
		other_user = String(u.id);
		users.push(other_user);
		await RealmMember.create({ id: randomUUID(), realm_id, member_type: 'user', member_id: other_user, role: 'operator', created_at: Date.now() } as never);
	});
	afterAll(async () => {
		if (!has_postgres) return;
		await ApiToken.destroy({ where: { user_id: [OWNER, other_user], name: { [(await import('sequelize')).Op.like]: 'dt-test:%' } } as never });
		await RealmMember.destroy({ where: { realm_id: realms } });
		await Realm.destroy({ where: { id: realms } });
		await User.update({ deleted_at: new Date() } as never, { where: { id: users } });
		await close_test_control_plane_store();
	});

	const enroll = (user_id: string, daemon_id?: string) => RealmService.create_token_for_realms(
		[realm_id], user_id, `dt-test:${uid()}`, { auto_enrolled: true }, daemon_id ? { daemon_id } : undefined,
	);
	const revoked = async (id: string) => Boolean((await ApiToken.findByPk(id, { raw: true }))?.revoked_at);

	it('enrolling again revokes that daemon\'s earlier token; the new one carries the daemon id', async () => {
		const d = `daemon-${uid()}`;
		const first = await enroll(OWNER, d);
		const second = await enroll(OWNER, d);
		expect(await revoked(first.id)).toBe(true);
		expect(await revoked(second.id)).toBe(false);
		expect(((await ApiToken.findByPk(second.id, { raw: true }))!.permissions as Record<string, unknown>).daemon_id).toBe(d);
	});

	it('another daemon\'s, a token made on purpose, and another person\'s token for the same daemon id are left alone', async () => {
		const d = `daemon-${uid()}`;
		const other_daemon = await enroll(OWNER, `daemon-${uid()}`);
		const shared = await enroll(OWNER);
		const someone_else = await enroll(other_user, d);
		await enroll(OWNER, d);
		await enroll(OWNER, d);
		for (const t of [other_daemon, shared, someone_else]) expect(await revoked(t.id)).toBe(false);
	});

	it('without a daemon id nothing is revoked (shared tokens; older daemons)', async () => {
		const a = await enroll(OWNER);
		const b = await enroll(OWNER);
		expect([await revoked(a.id), await revoked(b.id)]).toEqual([false, false]);
	});

	it('a daemon token records when it was last used', async () => {
		const t = await enroll(OWNER, `daemon-${uid()}`);
		expect((await ApiToken.findByPk(t.id, { raw: true }))!.last_used_at).toBeNull();
		await RealmService.resolve_token(t.token);
		await vi.waitFor(async () => expect((await ApiToken.findByPk(t.id, { raw: true }))!.last_used_at).not.toBeNull());
	});
});
