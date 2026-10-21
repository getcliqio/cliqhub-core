/**
 * PLAN-personal-channel, Core A — one personal channel per person ("how to reach me"), on a real Postgres.
 *
 *  - Made once per account (no org, no realm); a second call reuses it.
 *  - Private: the channel list never shows personal channels; `mine` returns only the caller's own.
 *  - Only its owner may change it (route policy); its in-app destination can't be removed.
 *  - A name reaches a person from a realm of an org they're in — not from other orgs. A channel may take any
 *    name; when a channel and a person share one, the channel wins (either order of creation).
 *  - The one-time merge folds per-org copies into one, keeping every destination and repointing rules.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { ChannelDestination, NotificationChannel, NotificationRule, Org, OrgMember, Realm, Setting, User } from '../../src/models/index.js';
import { ensure_personal_channel } from '../../src/services/per_user_channel.service.js';
import { NotificationService } from '../../src/services/notification.service.js';
import { RealmService } from '../../src/services/realm.service.js';
import { SequelizeAccessStore } from '../../src/auth/route_policy/store.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { PERSONAL_CHANNEL_PER_USER_MIGRATION_KEY, migrate_personal_channel_per_user } from '../../src/models/migrations/control_plane_schema_migrations.js';

const has_postgres = await postgres_reachable();
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

describe.skipIf(!has_postgres)('one personal channel per person', () => {
    const users: string[] = [];
    const orgs: string[] = [];
    const realms: string[] = [];
    let org_a: string;
    let org_b: string;
    let realm_a: string;
    let realm_b: string;
    let ana: { id: string; username: string };
    let ben: { id: string; username: string };

    const person = async (name: string) => {
        const username = `${name}${stamp}`.slice(0, 30);
        const u = await User.create({ username, email: `${username}@pc.test`, display_name: name, role: 'user', status: 'active', password_hash: null } as never);
        users.push(String(u.id));
        return { id: String(u.id), username };
    };
    const member = (org_id: string, user_id: string) => OrgMember.create({ org_id, user_id, role: 'member', status: 'active' } as never);

    beforeAll(async () => {
        if (!has_postgres) return;
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
        org_a = String((await Org.create({ slug: `pca${stamp}`, display_name: 'A' } as never)).id);
        org_b = String((await Org.create({ slug: `pcb${stamp}`, display_name: 'B' } as never)).id);
        orgs.push(org_a, org_b);
        ana = await person('ana');
        ben = await person('ben');
        await member(org_a, ana.id);
        await member(org_b, ben.id);
        realm_a = (await RealmService.create(ana.id, `pcra${stamp}`.slice(0, 40), 'A realm', { org_id: org_a })).id;
        realm_b = (await RealmService.create(ben.id, `pcrb${stamp}`.slice(0, 40), 'B realm', { org_id: org_b })).id;
        realms.push(realm_a, realm_b);
    });

    afterAll(async () => {
        if (!has_postgres) return;
        await NotificationChannel.destroy({ where: { user_id: users } as never });
        await NotificationChannel.destroy({ where: { org_id: orgs } as never });
        await Realm.destroy({ where: { id: realms } });
        await OrgMember.destroy({ where: { org_id: orgs } as never });
        await Org.destroy({ where: { id: orgs } as never });
        await User.update({ deleted_at: new Date() } as never, { where: { id: users } });
        await close_test_control_plane_store();
    });

    it('is made once for the account — no org, no realm — with in-app and the account email', async () => {
        const id = await ensure_personal_channel(ana.id, ana.username);
        expect(await ensure_personal_channel(ana.id, ana.username)).toBe(id);
        expect(await NotificationChannel.findByPk(id, { raw: true })).toMatchObject({ user_id: ana.id, org_id: null, realm_id: null, name: ana.username });
        const dests = (await ChannelDestination.findAll({ where: { channel_id: id }, raw: true })).map((d) => d.type).sort();
        expect(dests).toEqual(['cliqhub', 'email']);
    });

    it('is private: the org\'s channel list never shows it; `mine` returns only the caller\'s own', async () => {
        const id = await ensure_personal_channel(ana.id, ana.username);
        await ensure_personal_channel(ben.id, ben.username);
        const listed = await NotificationService.list_channels({ account: true, org_id: org_a });
        expect(listed.some((c) => c.user_id)).toBe(false);
        const mine = await NotificationService.list_channels({ mine_user_id: ana.id });
        expect(mine.map((c) => c.id)).toEqual([id]);
    });

    it('only its owner may change it (others: not found); its in-app destination can\'t be removed', async () => {
        const id = await ensure_personal_channel(ana.id, ana.username);
        const store = new SequelizeAccessStore();
        const as = (user_id: string) => ({ auth: { user: { id: user_id } } }) as never;
        expect(await store.record('channel', id, as(ana.id))).toMatchObject({ owner_user_id: ana.id, org_id: null });
        // Another person (even an admin of an org Ana is in) gets the owner rule against them: no org to judge by.
        expect(await store.record('channel', id, as(ben.id))).toMatchObject({ owner_user_id: ana.id, org_id: null, realm_ids: [] });

        await expect(NotificationService.update_channel({ id, destinations: [{ type: 'email', account: true }] }))
            .rejects.toMatchObject({ status: 422 });
        await NotificationService.update_channel({ id, destinations: [{ type: 'cliqhub' }, { type: 'slack', webhook_url: 'https://hooks.slack.com/services/T/B/x' }] });
        expect((await ChannelDestination.findAll({ where: { channel_id: id }, raw: true })).map((d) => d.type).sort()).toEqual(['cliqhub', 'slack']);
    });

    it('a name reaches a person from a realm of an org they\'re in — not from another org', async () => {
        const id = await ensure_personal_channel(ana.id, ana.username);
        expect((await NotificationService.find_realm_usable_channel(ana.username, realm_a))?.id).toBe(id);
        expect(await NotificationService.find_realm_usable_channel(ana.username, realm_b)).toBeNull();
    });

    it('a channel may take a member\'s name; then the name means the channel', async () => {
        const id = await ensure_personal_channel(ana.id, ana.username);
        const shared = await NotificationService.create_channel({ org_id: org_a, name: ana.username, destinations: [{ type: 'cliqhub' }] });
        expect((await NotificationService.find_realm_usable_channel(ana.username, realm_a))?.id).toBe(shared.id);
        await NotificationChannel.destroy({ where: { id: shared.id } });
        // Gone again: the name reaches Ana.
        expect((await NotificationService.find_realm_usable_channel(ana.username, realm_a))?.id).toBe(id);
    });

    it('migration: per-org copies fold into one — every destination kept, rules repointed — once', async () => {
        const cy = await person('cy');
        await member(org_a, cy.id);
        await member(org_b, cy.id);
        // Two old per-org copies (the one-per-user index comes back with the migration); the second has a Slack
        // destination and a rule.
        await NotificationChannel.destroy({ where: { user_id: cy.id } as never });
        await get_sequelize().query('DROP INDEX IF EXISTS cliq."notification_channels_user_uidx"');
        const now = Date.now();
        const old_a = randomUUID();
        const old_b = randomUUID();
        await NotificationChannel.create({ id: old_a, realm_id: null, org_id: org_a, user_id: cy.id, name: cy.username, enabled: 1, created_at: now - 2000, updated_at: now } as never);
        await NotificationChannel.create({ id: old_b, realm_id: null, org_id: org_b, user_id: cy.id, name: cy.username, enabled: 1, created_at: now - 1000, updated_at: now } as never);
        for (const [channel_id, type, config] of [[old_a, 'cliqhub', {}], [old_a, 'email', { account: true }], [old_b, 'cliqhub', {}], [old_b, 'slack', { webhook_url: 'https://hooks.slack.com/services/T/B/cy' }]] as const) {
            await ChannelDestination.create({ id: randomUUID(), channel_id, type, config, created_at: now } as never);
        }
        const rule_id = randomUUID();
        await NotificationRule.create({ id: rule_id, realm_id: realm_b, org_id: null, team_slug: null, event: 'run.failed', channel_id: old_b, priority: 0, recipients: null, system_key: null, locked: false, lock_reason: null, created_at: now, updated_at: now } as never);

        await Setting.destroy({ where: { key: PERSONAL_CHANNEL_PER_USER_MIGRATION_KEY } });
        await migrate_personal_channel_per_user(get_sequelize());

        const left = await NotificationChannel.findAll({ where: { user_id: cy.id } as never, raw: true });
        expect(left.map((c) => [c.id, c.org_id])).toEqual([[old_a, null]]);
        const types = (await ChannelDestination.findAll({ where: { channel_id: old_a }, raw: true })).map((d) => d.type).sort();
        expect(types).toEqual(['cliqhub', 'email', 'slack']);
        expect((await NotificationRule.findByPk(rule_id, { raw: true }))?.channel_id).toBe(old_a);
        expect(await Setting.findByPk(PERSONAL_CHANNEL_PER_USER_MIGRATION_KEY)).toBeTruthy();
        await NotificationRule.destroy({ where: { id: rule_id } });
    });
});
