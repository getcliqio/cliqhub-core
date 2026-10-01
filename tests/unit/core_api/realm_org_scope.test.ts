/**
 * Regression tests for org-scoped realm lookups used by the dashboard
 * runs list. `list_realm_ids_for_user_in_org` is the intersection helper
 * that gates realm results to the specified org — prevents runs from all
 * orgs leaking into the list when org_id is explicitly supplied.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

vi.mock('../../../src/lib/sequelize.js', () => ({
    get_sequelize: () => ({ query: vi.fn() }),
}));

vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({
        info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
    }),
}));

// vi.mock factories are hoisted above imports; use vi.hoisted so the
// spy references stay live in both the factory and the test cases.
const mocks = vi.hoisted(() => ({
    member_find: vi.fn(),
    realm_find: vi.fn(),
}));
const mock_member_find = mocks.member_find;
const mock_realm_find = mocks.realm_find;

vi.mock('../../../src/models/index.js', () => ({
    RealmMember: { findAll: mocks.member_find },
    Realm: { findAll: mocks.realm_find },
    Daemon: { findByPk: vi.fn() },
    Run: {},
    DaemonTeam: {},
    Team: {},
    TeamVersion: {},
    Scope: {},
    RealmDispatchQueue: {},
    ApiToken: { findOne: vi.fn(), findByPk: vi.fn() },
    AgentCatalog: { findAll: vi.fn(), findOne: vi.fn() },
    RealmAgentSetting: {},
    UserRealmAgentSetting: {},
    OrgAgentSetting: {},
    RealmInvite: { findOne: vi.fn() },
    User: { findByPk: vi.fn() },
    NotificationChannel: {},
    NotificationRule: {},
    Org: {},
    OrgAgentSetting: {},
    RealmDispatchKey: {},
    RealmDispatchQueue: {},
    RealmA2aSetting: {},
    AccountMeshSetting: {},
    AccountAgentSetting: {},
    AccountInvite: {},
    DaemonConfig: {},
    OrgMember: {},
    OrgRole: {},
    Draft: {},
    AuditLog: {},
    DownloadLog: {},
    Setting: {},
    TeamTag: {},
    Agent: {},
    Container: {},
    RunEvent: {},
    RunLog: {},
    RunLogLine: {},
    RunLogChunk: {},
    RunPhase: {},
    RunArtifact: {},
    RunSpan: {},
    WorkspaceTeam: {},
    WorkspaceSecret: {},
    InAppNotification: {},
    WebhookDelivery: {},
    ChannelDestination: {},
    NotificationSubscription: {},
    HubEvent: {},
    CustomEvent: {},
    Review: {},
    ReviewMessage: {},
    ReviewNotification: {},
    StoredArtifact: {},
    ApiToken: { findOne: vi.fn(), findByPk: vi.fn() },
    Run: {},
}));

const visible = vi.hoisted(() => ({ visible_realm_ids: vi.fn(), org_standing: vi.fn() }));
vi.mock('../../../src/auth/route_policy/visible.js', () => visible);

import { RealmService } from '../../../src/services/realm.service.js';

describe('RealmService.list_realm_ids_for_user_in_org', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('delegates to visible_realm_ids scoped to the org (same rules as the route policy)', async () => {
        visible.visible_realm_ids.mockResolvedValueOnce(['r-in-org-1', 'r-in-org-2']);
        const out = await RealmService.list_realm_ids_for_user_in_org('user-42', hub_legacy_uuid(7));
        expect(out).toEqual(['r-in-org-1', 'r-in-org-2']);
        expect(visible.visible_realm_ids).toHaveBeenCalledWith('user-42', { org_id: hub_legacy_uuid(7) });
    });

    it('list_realm_ids_for_user uses the same visibility rules', async () => {
        visible.visible_realm_ids.mockResolvedValueOnce([]);
        expect(await RealmService.list_realm_ids_for_user('user-42')).toEqual([]);
        expect(visible.visible_realm_ids).toHaveBeenCalledWith('user-42');
    });
});
