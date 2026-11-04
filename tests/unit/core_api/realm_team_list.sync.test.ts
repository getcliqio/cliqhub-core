/**
 * RealmTeamListService.sync_team — force overwrite of one team-list entry. The list is `realm_teams` (by id,
 * PLAN-team-bundle S4.1); the realm's row for the team says which version its daemons install.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/models/index.js', () => ({
    Realm: { findByPk: vi.fn() },
    DaemonTeam: {},
    Team: {},
    Scope: {},
    ScopeMember: {},
    User: {},
    Daemon: { findAll: vi.fn() },
    RealmAgentSetting: { findAll: vi.fn() },
    UserRealmAgentSetting: { findAll: vi.fn().mockResolvedValue([]) },
    OrgAgentSetting: { findAll: vi.fn().mockResolvedValue([]) },
    RealmMember: { findAll: vi.fn() },
    AccountAgentSetting: { findAll: vi.fn() },
    NotificationChannel: {},
    NotificationRule: {},
    NotificationSubscription: {},
    WebhookDelivery: {},
    InAppNotification: {},
    ChannelDestination: {},
    HubEvent: {},
    CustomEvent: {},
    Org: {},
    OrgMember: {},
    OrgRole: {},
    ApiToken: {},
    AccountInvite: {},
    RealmInvite: {},
    RealmDispatchKey: {},
    RealmDispatchQueue: {},
    RealmA2aSetting: {},
    AccountMeshSetting: {},
    DaemonConfig: {},
    Draft: {},
    AuditLog: {},
    DownloadLog: {},
    Setting: {},
    TeamTag: {},
    Agent: {},
    Container: {},
    Run: {},
    RunEvent: {},
    RunLog: {},
    RunLogLine: {},
    RunLogChunk: {},
    RunPhase: {},
    RunArtifact: {},
    RunSpan: {},
    Workspace: {},
    WorkspaceTeam: {},
    WorkspaceSecret: {},
    TeamVersion: {},
    TeamVersionSubTeam: {},
    Review: {},
    ReviewMessage: {},
    HugDelivery: {},
    StoredArtifact: {},
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

// The realm's list (realm_teams) and the catalog, as the service reads them.
const listed = { rows: [] as Array<{ realm_id: string; team_id: string; version_id: string; scope: string; slug: string; version: string }> };
vi.mock('../../../src/repositories/realm_team_repository.js', () => ({
    RealmTeamRepository: class {
        async find(realm_id: string, team_id: string) { return listed.rows.find((r) => r.realm_id === realm_id && r.team_id === team_id) ?? null; }
        async list(realm_id: string) { return listed.rows.filter((r) => r.realm_id === realm_id); }
    },
}));
vi.mock('../../../src/repositories/team_repository.js', () => ({
    TeamRepository: class {
        async find_by_name_and_scope(name: string, scope: string) { return name === 'claims' && scope === 'acme' ? { id: 'team-claims' } : name === 'other' ? { id: 'team-other' } : null; }
    },
}));

vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { Realm, RealmAgentSetting } from '../../../src/models/index.js';
import { AccountAgentSetting } from '../../../src/models/index.js';
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
        vi.mocked(Realm.findByPk).mockResolvedValue({ id: 'rlm_1' } as any);
        listed.rows = [{ realm_id: 'rlm_1', team_id: 'team-claims', version_id: 'v-1', scope: 'acme', slug: 'claims', version: '1.0.0' }];
    });

    it('force-installs a team that is on the realm list', async () => {

        const result = await RealmTeamListService.sync_team(
            'rlm_1',
            'user-1',
            'team-claims',
            ['org-1'],
        );

        // the version on the realm's list
        expect(DispatchService.install_team).toHaveBeenCalledWith({
            team_id: 'acme/claims',
            version: '1.0.0',
            realm_id: 'rlm_1',
            user_id: 'user-1',
            org_ids: ['org-1'],
            force: true,
        });
        expect(result.scope).toBe('acme');
        expect(result.slug).toBe('claims');
        expect(result.daemon_results).toEqual([{ daemon_id: 'd1', ok: true }]);
    });

    it('rejects teams that are not on the realm list', async () => {
        listed.rows = [{ realm_id: 'rlm_1', team_id: 'team-other', version_id: 'v-9', scope: 'acme', slug: 'other', version: '2.0.0' }];

        await expect(
            RealmTeamListService.sync_team('rlm_1', 'user-1', 'team-claims'),
        ).rejects.toThrow(/not on this realm's team list/i);

        expect(DispatchService.install_team).not.toHaveBeenCalled();
    });

    it('includes effective agent settings when present', async () => {
        vi.mocked(RealmAgentSetting.findAll).mockResolvedValue([
            { agent_name: 'cursor', setting_key: 'api_key', setting_value: 'sk-realm' },
        ] as any);

        await RealmTeamListService.sync_team(
            'rlm_1',
            'user-1',
            'team-claims',
        );

        expect(DispatchService.install_team).toHaveBeenCalledWith(
            expect.objectContaining({
                force: true,
                agent_settings: { cursor: { api_key: 'sk-realm' } },
            }),
        );
    });

    it('returns per-daemon failure when install throws', async () => {
        vi.mocked(DispatchService.install_team).mockRejectedValue(new Error('all offline'));

        const result = await RealmTeamListService.sync_team(
            'rlm_1',
            'user-1',
            'team-claims',
        );

        expect(result.daemon_results).toEqual([
            { daemon_id: '*', ok: false, error: 'all offline' },
        ]);
    });
});
