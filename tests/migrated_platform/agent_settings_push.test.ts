/**
 * Saved agent settings reach the daemons, on a real Postgres (skipped without one).
 *
 *  - A realm save goes to that realm's daemons with the realm-over-org value; a cleared key falls back
 *    to the org value, or is removed (null) when the org has none.
 *  - An org save goes to every realm of the org, except realms that set the key themselves.
 *  - A daemon that registers gets the realm's full effective settings.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { AgentCatalog, Org, OrgAgentSetting, Realm, RealmAgentSetting } from '../../src/models/index.js';
import { AgentService } from '../../src/services/agent.service.js';
import { RealmTeamListService } from '../../src/services/realm_team_list.service.js';
import { DispatchService } from '../../src/services/dispatch.service.js';
import * as outbox from '../../src/services/command_outbox.service.js';

const has_postgres = await postgres_reachable();
const uid = () => `asp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('saved agent settings reach the daemons', () => {
    const user_id = hub_legacy_uuid(1);
    let org_id: string;
    let realm_a: string;
    let realm_b: string;
    let agent_id: string;
    let agent_name: string;
    const service = new AgentService();
    let push: ReturnType<typeof vi.spyOn>;

    /** Pushes per realm, as `{ realm_id: settings }`. */
    const pushed = () => Object.fromEntries(push.mock.calls.map(([arg]) => {
        const { realm_id, settings } = arg as { realm_id: string; settings: Record<string, string | null> };
        return [realm_id, settings];
    }));

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
        org_id = randomUUID();
        await Org.create({ id: org_id, slug: uid().slice(0, 40), display_name: 'Settings push', activated_at: new Date() } as never);
        const now = Date.now();
        realm_a = uid();
        realm_b = uid();
        for (const id of [realm_a, realm_b]) {
            await Realm.create({ id, slug: id, name: id, owner_user_id: user_id, created_by: user_id, org_id, created_at: now, updated_at: now } as never);
        }
        agent_name = uid();
        await service.register(org_id, {
            name: agent_name,
            manifest: { name: agent_name, entry: './agent.js', agent_type: 'exec', settings: { optional: ['provider', 'base_branch'] } },
            description: 'git-like',
        });
        agent_id = (await AgentCatalog.findOne({ where: { name: agent_name } }))!.id;
    });

    beforeEach(async () => {
        await OrgAgentSetting.destroy({ where: { org_id } });
        await RealmAgentSetting.destroy({ where: { realm_id: [realm_a, realm_b] } });
        push = vi.spyOn(DispatchService, 'push_agent_settings_to_realm').mockResolvedValue(undefined);
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        await OrgAgentSetting.destroy({ where: { org_id } });
        await RealmAgentSetting.destroy({ where: { realm_id: [realm_a, realm_b] } });
        await AgentCatalog.destroy({ where: { id: agent_id } });
        await Realm.destroy({ where: { id: [realm_a, realm_b] } });
        await Org.destroy({ where: { id: org_id } });
        await close_test_control_plane_store();
    });

    it('an org save goes to every realm of the org, except realms that set the key themselves', async () => {
        await service.update_settings(org_id, agent_id, { values: { base_branch: 'develop' } }, realm_b);
        push.mockClear();

        await service.update_settings(org_id, agent_id, { values: { provider: 'bitbucket', base_branch: 'main' } });
        expect(pushed()).toEqual({
            [realm_a]: { provider: 'bitbucket', base_branch: 'main' },
            [realm_b]: { provider: 'bitbucket' },
        });
    });

    it('a realm save goes to that realm only, realm value over org', async () => {
        await service.update_settings(org_id, agent_id, { values: { provider: 'bitbucket' } });
        push.mockClear();

        await service.update_settings(org_id, agent_id, { values: { provider: 'github' } }, realm_a);
        expect(pushed()).toEqual({ [realm_a]: { provider: 'github' } });
    });

    it('a cleared realm key falls back to the org value, or is removed when the org has none', async () => {
        await service.update_settings(org_id, agent_id, { values: { provider: 'bitbucket' } });
        await service.update_settings(org_id, agent_id, { values: { provider: 'github', base_branch: 'dev' } }, realm_a);
        push.mockClear();

        await service.update_settings(org_id, agent_id, { clear: ['provider', 'base_branch'] }, realm_a);
        expect(pushed()).toEqual({ [realm_a]: { provider: 'bitbucket', base_branch: null } });
    });

    it('a failed push does not fail the save', async () => {
        push.mockRejectedValueOnce(new Error('outbox down'));
        await expect(service.update_settings(org_id, agent_id, { values: { provider: 'bitbucket' } }, realm_a)).resolves.toBe(true);
        expect((await RealmAgentSetting.findOne({ where: { realm_id: realm_a, setting_key: 'provider' } }))?.setting_value).toBe('bitbucket');
    });

    it('a registering daemon gets the realm\'s full effective settings', async () => {
        const enqueue = vi.spyOn(outbox, 'command_outbox_enqueue').mockResolvedValue({ tx_id: 'tx' } as never);
        await service.update_settings(org_id, agent_id, { values: { provider: 'bitbucket', base_branch: 'main' } });
        await service.update_settings(org_id, agent_id, { values: { base_branch: 'develop' } }, realm_a);

        await RealmTeamListService.push_settings_to_daemon(realm_a, 'daemon-1');
        const sent = enqueue.mock.calls
            .filter(([daemon, op]) => daemon === 'daemon-1' && op === '/v1/settings/set')
            .map(([, , body]) => body as { key: string; value: string })
            .filter((b) => b.key.startsWith(`agents.${agent_name}.`));
        expect(sent).toEqual(expect.arrayContaining([
            { workspace_dir: null, key: `agents.${agent_name}.provider`, value: 'bitbucket' },
            { workspace_dir: null, key: `agents.${agent_name}.base_branch`, value: 'develop' },
        ]));
        expect(sent).toHaveLength(2);
        enqueue.mockRestore();
    });
});
