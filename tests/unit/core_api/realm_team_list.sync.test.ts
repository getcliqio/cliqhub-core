/**
 * RealmTeamListService.sync_team — force overwrite of one team-list entry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/models/index.js', () => ({
    Realm: { findByPk: vi.fn() },
    Team: {},
    Scope: {},
    Daemon: { findAll: vi.fn() },
    RealmAgentSetting: { findAll: vi.fn() },
    RealmMember: { findAll: vi.fn() },
}));

vi.mock('../../../src/db/models/index.js', () => ({
    AccountAgentSetting: { findAll: vi.fn() },
}));

vi.mock('../../../src/services/realm.service.js', () => ({
    RealmService: {
        require_admin: vi.fn(async () => undefined),
        assert_member: vi.fn(async () => undefined),
    },
}));

vi.mock('../../../src/services/dispatch.service.js', () => ({
    DispatchService: {
        install_team: vi.fn(),
    },
}));

vi.mock('../../../src/services/in_app_notification.service.js', () => ({
    InAppNotificationService: { create: vi.fn() },
}));

vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { Realm, RealmAgentSetting } from '../../../src/models/index.js';
import { AccountAgentSetting } from '../../../src/db/models/index.js';
import { RealmService } from '../../../src/services/realm.service.js';
import { DispatchService } from '../../../src/services/dispatch.service.js';
import { RealmTeamListService } from '../../../src/services/realm_team_list.service.js';

describe('RealmTeamListService.sync_team', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(RealmAgentSetting.findAll).mockResolvedValue([] as any);
        vi.mocked(AccountAgentSetting.findAll).mockResolvedValue([] as any);
        vi.mocked(DispatchService.install_team).mockResolvedValue({
            team_id: 'acme/claims',
            results: [{ daemon_id: 'd1', ok: true }],
        } as any);
    });

    it('force-installs a team that is on the realm list', async () => {
        vi.mocked(Realm.findByPk).mockResolvedValue({
            id: 'rlm_1',
            team_list: [{ scope: 'acme', slug: 'claims' }],
        } as any);

        const result = await RealmTeamListService.sync_team(
            'rlm_1',
            'user-1',
            { scope: 'acme', slug: 'claims' },
            ['scope-1'],
            ['org-1'],
        );

        expect(RealmService.require_admin).toHaveBeenCalledWith('rlm_1', 'user-1');
        expect(DispatchService.install_team).toHaveBeenCalledWith({
            team_id: 'acme/claims',
            realm_id: 'rlm_1',
            user_id: 'user-1',
            scope_ids: ['scope-1'],
            org_ids: ['org-1'],
            force: true,
        });
        expect(result.scope).toBe('acme');
        expect(result.slug).toBe('claims');
        expect(result.daemon_results).toEqual([{ daemon_id: 'd1', ok: true }]);
    });

    it('rejects teams that are not on the realm list', async () => {
        vi.mocked(Realm.findByPk).mockResolvedValue({
            id: 'rlm_1',
            team_list: [{ scope: 'acme', slug: 'other' }],
        } as any);

        await expect(
            RealmTeamListService.sync_team('rlm_1', 'user-1', { scope: 'acme', slug: 'claims' }),
        ).rejects.toThrow(/not on this realm's team list/i);

        expect(DispatchService.install_team).not.toHaveBeenCalled();
    });

    it('includes effective agent settings when present', async () => {
        vi.mocked(Realm.findByPk).mockResolvedValue({
            id: 'rlm_1',
            team_list: [{ scope: 'acme', slug: 'claims' }],
        } as any);
        vi.mocked(RealmAgentSetting.findAll).mockResolvedValue([
            { agent_name: 'cursor', setting_key: 'api_key', setting_value: 'sk-realm' },
        ] as any);

        await RealmTeamListService.sync_team(
            'rlm_1',
            'user-1',
            { scope: 'acme', slug: 'claims' },
        );

        expect(DispatchService.install_team).toHaveBeenCalledWith(
            expect.objectContaining({
                force: true,
                agent_settings: { cursor: { api_key: 'sk-realm' } },
            }),
        );
    });

    it('returns per-daemon failure when install throws', async () => {
        vi.mocked(Realm.findByPk).mockResolvedValue({
            id: 'rlm_1',
            team_list: [{ scope: 'acme', slug: 'claims' }],
        } as any);
        vi.mocked(DispatchService.install_team).mockRejectedValue(new Error('all offline'));

        const result = await RealmTeamListService.sync_team(
            'rlm_1',
            'user-1',
            { scope: 'acme', slug: 'claims' },
        );

        expect(result.daemon_results).toEqual([
            { daemon_id: '*', ok: false, error: 'all offline' },
        ]);
    });
});
