import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import {
    close_test_control_plane_store,
    open_test_control_plane_store,
    postgres_reachable,
} from './helpers/control_plane_store.js';
import { Realm, RealmMember } from '../../src/models/index.js';
import { NotificationChannel } from '../../src/models/index.js';

import { RealmService } from '../../src/services/realm.service.js';
import { OrgAgentSetting, RealmAgentSetting } from '../../src/db/models/index.js';
import { RealmAgentSettingRepository } from '../../src/repositories/realm_agent_setting_repository.js';

const has_postgres = await postgres_reachable();

const user_a = hub_legacy_uuid(1);
/** Org ID seeded in beforeAll — org-scoped settings use this instead of user_id. */
let org_id: string;

async function cleanup_user(user_id: string): Promise<void> {
    const created = await Realm.findAll({ where: { created_by: user_id } });
    for (const row of created) {
        await RealmMember.destroy({ where: { realm_id: row.id } });
        await NotificationChannel.destroy({ where: { realm_id: row.id } });
        await Realm.destroy({ where: { id: row.id } });
    }
    await RealmMember.destroy({ where: { member_type: 'user', member_id: user_id } });
    if (org_id) {
        await OrgAgentSetting.destroy({ where: { org_id } });
    }
    await RealmAgentSetting.destroy({ where: { user_id: user_id } });
    // Account-owned channels can be shared with other tests; only drop the
    // named test channels we seed below.
    await NotificationChannel.destroy({ where: { name: 'test-account-slack', realm_id: null } });
}

beforeAll(async () => {
    if (!has_postgres) return;
    process.env.CLIQ_BFF_LOG_LEVEL = 'error';
    await open_test_control_plane_store();

    // Ensure the test user has a personal org so RealmService.create can
    // resolve org_id and snapshot org-level agent settings into new realms.
    const { ensure_personal_org_for_user } = await import('../../src/db/migrate_ensure_user_orgs.js');
    const org = await ensure_personal_org_for_user(user_a, 'snapshot-test-user');
    org_id = org.id;
});

beforeEach(async () => {
    if (!has_postgres) return;
    await cleanup_user(user_a);
});

afterAll(async () => {
    if (!has_postgres) return;
    await cleanup_user(user_a);
    await close_test_control_plane_store();
});

describe.skipIf(!has_postgres)('RealmService.create snapshot behavior', () => {
    it('snapshots org agent settings into the new realm', async () => {
        // Seed org-level defaults (replaces the old account-level settings).
        await OrgAgentSetting.bulkCreate([
            { org_id, agent_name: 'openai', setting_key: 'api_key', value: 'sk-account-key' },
            { org_id, agent_name: 'openai', setting_key: 'base_url', value: 'https://api.openai.com/v1' },
            { org_id, agent_name: 'anthropic', setting_key: 'api_key', value: 'sk-ant-account' },
        ]);

        // Force the realm onto the same org we seeded (`snapshot-test-user`
        // via ensure_personal_org_for_user in beforeAll). Without this,
        // RealmService.create resolves org_id from the User's canonical
        // username ('migrated-platform-user' — seeded by the test store
        // helper), which is a different org and would see zero settings.
        const realm = await RealmService.create(user_a, 'snap-agents', 'Snap Agents', { org_id });

        const rows = await RealmAgentSetting.findAll({
            where: { user_id: user_a, realm_id: realm.id },
            raw: true,
        });
        expect(rows).toHaveLength(3);
        const keys = new Set(rows.map((r: any) => `${r.agent_name}/${r.setting_key}=${r.value}`));
        expect(keys).toContain('openai/api_key=sk-account-key');
        expect(keys).toContain('openai/base_url=https://api.openai.com/v1');
        expect(keys).toContain('anthropic/api_key=sk-ant-account');
    });

    it('creates the realm even when the org has no agent settings', async () => {
        const realm = await RealmService.create(user_a, 'no-agents', 'No Agents');
        const rows = await RealmAgentSetting.findAll({
            where: { user_id: user_a, realm_id: realm.id },
            raw: true,
        });
        expect(rows).toHaveLength(0);
    });

    it('creates realm cliqhub channel on realm create', async () => {
        const realm = await RealmService.create(user_a, 'snap-notifs', 'Snap Notifs');

        /** Provider is no longer a column — the auto-provisioned realm
         *  channel is identified by (realm_id, name='cliqhub') or by its
         *  deterministic id `cliqhub-<realm_id>`. */
        const channel = await NotificationChannel.findOne({
            where: { realm_id: realm.id, name: 'cliqhub' },
        });
        expect(channel).not.toBeNull();
        expect(channel!.id).toBe(`cliqhub-${realm.id}`);
        expect(channel!.enabled).toBe(1);
    });

    it('cleans up realm_agent_settings on realm delete', async () => {
        await OrgAgentSetting.create({
            org_id, agent_name: 'openai', setting_key: 'api_key', value: 'sk-1',
        });
        // Same reasoning as above — pin the realm to the seeded org.
        const realm = await RealmService.create(user_a, 'cleanup-realm', 'Cleanup', { org_id });
        const before = await RealmAgentSetting.findAll({ where: { realm_id: realm.id } });
        expect(before.length).toBeGreaterThan(0);

        await RealmService.remove(realm.id, user_a);

        const after = await RealmAgentSetting.findAll({ where: { realm_id: realm.id } });
        expect(after).toHaveLength(0);
    });
});

describe.skipIf(!has_postgres)('RealmAgentSettingRepository.reset_to_org', () => {
    it('copies the current org value on top of a divergent realm value', async () => {
        await OrgAgentSetting.create({
            org_id, agent_name: 'openai', setting_key: 'api_key', value: 'sk-account',
        });
        const realm = await RealmService.create(user_a, 'reset-copy', 'Reset Copy');

        // Diverge the realm row.
        const repo = new RealmAgentSettingRepository();
        await repo.upsert(user_a, realm.id, 'openai', 'api_key', 'sk-realm-override');
        const result = await repo.reset_to_org(org_id, user_a, realm.id, 'openai', 'api_key');
        expect(result).toBe('copied');

        const row = await RealmAgentSetting.findOne({
            where: {
                user_id: user_a, realm_id: realm.id, agent_name: 'openai', setting_key: 'api_key',
            },
            raw: true,
        }) as any;
        expect(row?.value).toBe('sk-account');
    });

    it('removes the realm row when the org has no value for that key', async () => {
        const realm = await RealmService.create(user_a, 'reset-remove', 'Reset Remove');
        const repo = new RealmAgentSettingRepository();
        // Realm-only override with no org backing.
        await repo.upsert(user_a, realm.id, 'openai', 'api_key', 'sk-realm-only');
        const result = await repo.reset_to_org(org_id, user_a, realm.id, 'openai', 'api_key');
        expect(result).toBe('removed');

        const row = await RealmAgentSetting.findOne({
            where: {
                user_id: user_a, realm_id: realm.id, agent_name: 'openai', setting_key: 'api_key',
            },
        });
        expect(row).toBeNull();
    });
});
