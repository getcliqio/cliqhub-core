/**
 * Regression tests for RealmService.ensure_account_default_realm.
 *
 * Historical bug (prod fossil `99a2f0f1`): the old implementation
 * greedily renamed and reassigned ownership of whatever realm sat at
 * `users.default_realm_id` if the slug ended in `.default`. Three
 * users (sapan, bharat, krupali) ended up sharing one physical realm
 * row, each rewriting the slug and stealing ownership at every login.
 * `list_recent` then leaked runs across users via shared daemon
 * members.
 *
 * These tests lock in the dumb, no-rename, no-reown contract under the
 * current org-scoped realm slug model (every personal realm has slug
 * `'default'`, uniqueness scoped per org):
 *   1. Each user gets a distinct realm in their own personal org.
 *   2. A stale cross-user `default_realm_id` is cleared and a fresh
 *      personal realm is created; the other user's realm is untouched.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Op } from 'sequelize';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { Realm, RealmMember } from '../../src/models/index.js';
import { User } from '../../src/db/models/index.js';
import { RealmService } from '../../src/services/realm.service.js';

const has_postgres = await postgres_reachable();
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Fixture {
    id: number;
    username: string;
}

const users: Fixture[] = [];

async function make_user(label: string): Promise<Fixture> {
    const username = `steal${label}${stamp}`.slice(0, 32).toLowerCase();
    const email = `${username}@regression.test`;
    const created: any = await (User as any).create({
        username,
        email,
        password_hash: 'x'.repeat(60),
        role: 'user',
    });
    const fixture = { id: created.id, username };
    users.push(fixture);
    return fixture;
}

async function cleanup(): Promise<void> {
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const string_ids = ids.map(String);

    await (User as any).update(
        { default_realm_id: null },
        { where: { id: { [Op.in]: ids } } },
    );

    const owned = await (Realm as any).findAll({
        where: { owner_user_id: { [Op.in]: string_ids } },
        attributes: ['id'],
    });
    const realm_ids: string[] = owned.map((r: any) => r.id);
    for (const realm_id of realm_ids) {
        await (RealmMember as any).destroy({ where: { realm_id } });
        await (Realm as any).destroy({ where: { id: realm_id } });
    }

    await (RealmMember as any).destroy({
        where: { member_type: 'user', member_id: { [Op.in]: string_ids } },
    });
    await (User as any).destroy({ where: { id: { [Op.in]: ids } } });
}

beforeAll(async () => {
    if (!has_postgres) return;
    process.env.CLIQ_BFF_LOG_LEVEL = 'error';
    await open_test_control_plane_store();
});

afterAll(async () => {
    if (!has_postgres) return;
    await cleanup();
    await close_test_control_plane_store();
});

describe.skipIf(!has_postgres)('ensure_account_default_realm never steals', () => {
    it('two users each get a distinct personal realm in their own org', async () => {
        const alice = await make_user('alice');
        const bob = await make_user('bob');

        const a = await RealmService.ensure_account_default_realm(String(alice.id), alice.username);
        const b = await RealmService.ensure_account_default_realm(String(bob.id), bob.username);

        expect(a.default_realm_id).not.toBe(b.default_realm_id);
        // Org-scoped slug: every personal realm is 'default' inside its
        // own personal org (uniqueness = org_id + slug).
        expect(a.default_realm_slug).toBe('default');
        expect(b.default_realm_slug).toBe('default');

        const a_row = await (Realm as any).findByPk(a.default_realm_id);
        const b_row = await (Realm as any).findByPk(b.default_realm_id);
        expect(a_row.owner_user_id).toBe(String(alice.id));
        expect(b_row.owner_user_id).toBe(String(bob.id));
        // Different personal orgs — that's what makes both slugs safely 'default'.
        expect(a_row.org_id).not.toBe(b_row.org_id);
    });

    it('a stale cross-user default_realm_id is cleared and a fresh realm is minted (no steal)', async () => {
        const alice = await make_user('alicex');
        const bob = await make_user('bobx');

        const a = await RealmService.ensure_account_default_realm(String(alice.id), alice.username);

        // Simulate the prod fossil: point bob's default_realm_id at
        // alice's realm as if the old buggy code had done it.
        await (User as any).update(
            { default_realm_id: a.default_realm_id },
            { where: { id: bob.id } },
        );

        const b = await RealmService.ensure_account_default_realm(String(bob.id), bob.username);

        // Bob got his OWN realm, not alice's.
        expect(b.default_realm_id).not.toBe(a.default_realm_id);
        expect(b.default_realm_slug).toBe('default');

        // Alice's realm is untouched.
        const a_row = await (Realm as any).findByPk(a.default_realm_id);
        expect(a_row.slug).toBe('default');
        expect(a_row.owner_user_id).toBe(String(alice.id));

        // Bob's user row now points at his own new realm.
        const bob_user = await (User as any).findByPk(bob.id);
        expect(bob_user.default_realm_id).toBe(b.default_realm_id);
    });

    it('reclaims personal-org default when owner_user_id is an orphan (remint drift)', async () => {
        const alice = await make_user('aliceo');
        const first = await RealmService.ensure_account_default_realm(String(alice.id), alice.username);
        const realm_id = first.default_realm_id;

        // Simulate remint leaving a bare int / missing user as owner.
        await (Realm as any).update(
            { owner_user_id: '999999', created_by: '999999' },
            { where: { id: realm_id } },
        );
        await (User as any).update(
            { default_realm_id: null },
            { where: { id: alice.id } },
        );

        const again = await RealmService.ensure_account_default_realm(String(alice.id), alice.username);

        expect(again.default_realm_id).toBe(realm_id);
        const row = await (Realm as any).findByPk(realm_id);
        expect(row.owner_user_id).toBe(String(alice.id));
        expect(row.slug).toBe('default');
    });
});
