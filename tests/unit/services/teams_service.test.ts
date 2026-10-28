import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { Op } from 'sequelize';
import { TeamsService, team_query_where } from '../../../src/services/teams_service.js';
import { ALICE, BOB, ORG_ADMIN, UNAUTHED, SITE_ADMIN } from '../../helpers/fixtures.js';

vi.mock('../../../src/lib/sequelize.js', () => ({
    get_sequelize: vi.fn().mockReturnValue({
        transaction: vi.fn().mockImplementation(async (fn: any) => fn({})),
        query: vi.fn().mockResolvedValue([[{ total: 0 }], []]),
        escape: vi.fn().mockImplementation((v: string) => `'${v}'`),
    }),
}));

/* ─── Module mocks ────────────────────────────────────────────── */

vi.mock('../../../src/db/sequelize.js', () => ({
    get_sequelize: vi.fn().mockReturnValue({
        transaction: vi.fn().mockImplementation(async (fn: any) => fn({})),
        query: vi.fn().mockResolvedValue([[{ total: 0 }], []]),
    }),
}));

vi.mock('../../../src/services/package_parser.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/services/package_parser.js')>();
    return {
        ...actual,
        extract_package: vi.fn().mockResolvedValue({
            team_yml: { phases: [], description: 'test', tools: [], tags: ['ai'] },
            roles: [{ name: 'dev', content_md: '# Dev' }],
            readme: '# README',
        }),
        normalize_tags: vi.fn().mockImplementation((tags: string[]) => tags),
        compute_next_version: vi.fn().mockReturnValue('1.0.1'),
    };
});

/**
 * Who holds teams.publish / teams.publish.delete in each scope's org (PLAN-team-visibility §3.3):
 * Alice in `alice`, Bob in `bob`, the org admin in `acme`.
 */
const SCOPE_PUBLISHERS: Record<string, string> = {
    'org-alice': hub_legacy_uuid(1), 'org-bob': hub_legacy_uuid(2), 'org-acme': hub_legacy_uuid(3),
};
vi.mock('../../../src/auth/permissions.js', () => ({
    require_permission: vi.fn(async (org_id: string, user_id: string, permission: string) => {
        if (SCOPE_PUBLISHERS[org_id] !== user_id) throw new Error(`Permission '${permission}' is required`);
    }),
}));

vi.mock('../../../src/services/events_service.js', () => ({
    EventSubmitService: { submit: vi.fn().mockResolvedValue({}) },
}));

const mock_team_find_by_pk = vi.fn();
const mock_team_update = vi.fn();
const mock_user_find_by_pk = vi.fn();

vi.mock('../../../src/models/index.js', () => ({
    Team: {
        findByPk: (...args: any[]) => mock_team_find_by_pk(...args),
        update: (...args: any[]) => mock_team_update(...args),
        findAndCountAll: vi.fn().mockResolvedValue({ count: 0, rows: [] }),
        findAll: vi.fn().mockResolvedValue([]),
        sequelize: {
            transaction: vi.fn().mockImplementation(async (fn: any) => fn({})),
            escape: vi.fn().mockImplementation((v: string) => `'${v}'`),
        },
    },
    // Every scope belongs to an org of the same name (`org-<slug>`); see SCOPE_PUBLISHERS.
    Scope: {
        findAll: vi.fn().mockResolvedValue([]),
        findOne: vi.fn().mockImplementation(async (q: { where?: { slug?: string } }) => {
            const slug = q?.where?.slug;
            return slug ? { id: `s-${slug}`, slug, org_id: `org-${slug}`, owner_id: null } : null;
        }),
    },
    OrgMember: {
        findOne: vi.fn().mockResolvedValue(null),
    },
    User: { findByPk: (...args: any[]) => mock_user_find_by_pk(...args) },
    ApiToken: { findOne: vi.fn(), findByPk: vi.fn(), create: vi.fn() },
    AgentCatalog: { findAll: vi.fn(), findOne: vi.fn() },
    Daemon: { findByPk: vi.fn(), findAll: vi.fn() },
    Realm: { findOne: vi.fn(), findAll: vi.fn(), findByPk: vi.fn(), create: vi.fn() },
    RealmMember: { findOne: vi.fn(), findAll: vi.fn(), create: vi.fn() },
    RealmDispatchQueue: { findOne: vi.fn(), findAll: vi.fn() },
    Run: { findByPk: vi.fn(), findAll: vi.fn() },
    DaemonTeam: { findOne: vi.fn(), findAll: vi.fn() },
    RealmAgentSetting: {},
    UserRealmAgentSetting: { findAll: vi.fn(), findOrCreate: vi.fn(), bulkCreate: vi.fn(), destroy: vi.fn() },
    OrgAgentSetting: { findAll: vi.fn(), findOne: vi.fn() },
    RealmInvite: { findOne: vi.fn(), create: vi.fn() },
    TeamVersion: {},
    WorkspaceTeam: {},
    Workspace: {},
    ScopeMember: {},
    NotificationChannel: {},
    NotificationRule: {},
    NotificationSubscription: {},
    Org: {},
    OrgMember: {},
    OrgRole: {},
    RealmDispatchKey: {},
    RealmDispatchQueue: {},
    RealmA2aSetting: {},
    AccountMeshSetting: {},
    AccountAgentSetting: {},
    AccountInvite: {},
    DaemonConfig: {},
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
    WorkspaceSecret: {},
    InAppNotification: {},
    WebhookDelivery: {},
    ChannelDestination: {},
    HubEvent: {},
    CustomEvent: {},
    Review: {},
    ReviewMessage: {},
    ReviewNotification: {},
    StoredArtifact: {},
}));

/* ─── Repo factories ─────────────────────────────────────────── */

function make_team_repo() {
    return {
        find_by_id: vi.fn(),
        find_by_name_and_scope: vi.fn(),
        find_all_q: vi.fn().mockResolvedValue([]),
        list_filtered: vi.fn().mockResolvedValue([]),
        count_filtered: vi.fn().mockResolvedValue(0),
        find_author_username: vi.fn().mockResolvedValue('alice'),
        create: vi.fn().mockResolvedValue(1),
        update: vi.fn().mockResolvedValue(undefined),
        update_description: vi.fn().mockResolvedValue(undefined),
        delete_by_id: vi.fn().mockResolvedValue(undefined),
        update_listed: vi.fn().mockResolvedValue(undefined),
        update_visibility_and_listed: vi.fn().mockResolvedValue(undefined),
        update_name: vi.fn().mockResolvedValue(undefined),
        update_install_count: vi.fn().mockResolvedValue(undefined),
        list_by_scope: vi.fn().mockResolvedValue([]),
        list_by_scope_list: vi.fn().mockResolvedValue([]),
        set_fork_origin: vi.fn().mockResolvedValue(undefined),
        count_forks: vi.fn().mockResolvedValue(0),
    };
}

function make_version_repo() {
    return {
        find_by_team_and_version: vi.fn(),
        find_latest_version: vi.fn(),
        find_detail_by_team_and_version: vi.fn(),
        list_by_team_id: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(10),
        delete_by_id: vi.fn().mockResolvedValue(undefined),
        find_package_by_version: vi.fn(),
        find_latest_package: vi.fn(),
        list_packages_by_team: vi.fn().mockResolvedValue([]),
        find_id_and_package: vi.fn(),
    };
}

function make_tag_repo() {
    return {
        find_by_team_ids: vi.fn().mockResolvedValue([]),
        find_by_team_id: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(undefined),
        delete_by_team_id: vi.fn().mockResolvedValue(undefined),
    };
}

function make_download_log_repo() {
    return {
        find_by_team_key_date: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(undefined),
    };
}

function make_storage() {
    return {
        write: vi.fn().mockResolvedValue(undefined),
        read: vi.fn().mockResolvedValue(Buffer.from('zip-data')),
        delete: vi.fn().mockResolvedValue(undefined),
    };
}

function make_scope_repo() {
    return { find_by_slug: vi.fn() };
}

function make_audit_repo() {
    return { create: vi.fn().mockResolvedValue(undefined) };
}

/* ─── Fixtures ────────────────────────────────────────────────── */

const PUBLIC_TEAM = {
    id: hub_legacy_uuid(1), name: 'my-team', scope: 'alice',
    description: 'desc', author_id: hub_legacy_uuid(1),
    license: 'MIT', visibility: 'public' as const, listed: 1,
    created_at: '2025-01-01', updated_at: '2025-06-01', install_count: 10,
};

const PRIVATE_TEAM = { ...PUBLIC_TEAM, visibility: 'private' as const, author_id: hub_legacy_uuid(99), scope: 'other' };

const DATA_BASE64 = Buffer.from('test').toString('base64');

/* ─── Helper to build service with all repos ─────────────────── */

function build_service(overrides: {
    team_repo?: ReturnType<typeof make_team_repo>;
    version_repo?: ReturnType<typeof make_version_repo>;
    tag_repo?: ReturnType<typeof make_tag_repo>;
    download_log_repo?: ReturnType<typeof make_download_log_repo>;
    storage?: ReturnType<typeof make_storage>;
    packages_path?: string;
    scope_repo?: ReturnType<typeof make_scope_repo>;
    audit_repo?: ReturnType<typeof make_audit_repo>;
} = {}) {
    const team_repo = overrides.team_repo ?? make_team_repo();
    const version_repo = overrides.version_repo ?? make_version_repo();
    const tag_repo = overrides.tag_repo ?? make_tag_repo();
    const service = new TeamsService(
        team_repo as any, version_repo as any, tag_repo as any,
        overrides.download_log_repo as any, overrides.storage as any,
        overrides.packages_path, overrides.scope_repo as any, overrides.audit_repo as any,
    );
    return { service, team_repo, version_repo, tag_repo };
}

/* ================================================================
   get  (unified list — replaces list, search, list_my_teams, list_all_my_teams)
   ================================================================ */

describe('TeamsService — get (list)', () => {
    let service: TeamsService;
    let team_repo: ReturnType<typeof make_team_repo>;
    let tag_repo: ReturnType<typeof make_tag_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        const built = build_service();
        service = built.service;
        team_repo = built.team_repo;
        tag_repo = built.tag_repo;
    });

    it('returns paginated teams with tags attached', async () => {
        team_repo.count_filtered.mockResolvedValueOnce(1);
        team_repo.list_filtered.mockResolvedValueOnce([{ id: hub_legacy_uuid(1), name: 't1' }]);
        tag_repo.find_by_team_ids.mockResolvedValueOnce([{ team_id: hub_legacy_uuid(1), tag: 'ai' }]);

        const result = await service.get(UNAUTHED, {});
        expect(result.total).toBe(1);
        expect(result.tag_map.get(hub_legacy_uuid(1))).toEqual(['ai']);
    });

    it("private teams in the catalog: only the scopes the caller is a member of (PLAN-team-visibility §3.2)", async () => {
        await service.get(ORG_ADMIN, {});
        const where = team_repo.count_filtered.mock.calls[0]![0] as Record<symbol, Array<Record<symbol, Array<Record<string, unknown>>>>>;
        const visibility = where[Op.and]![0]![Op.or]!;
        const priv = visibility.find((c) => c.visibility === 'private') as { scope: Record<symbol, string[]> };
        // ORG_ADMIN's personal scope isn't one they're a member of in this fixture; acme is.
        expect(priv.scope[Op.in]).toEqual(['acme']);
        expect(visibility).toContainEqual({ visibility: 'draft', author_id: ORG_ADMIN.user!.id });
    });

    it('caps limit to 100', async () => {
        const result = await service.get(UNAUTHED, { limit: 999 });
        expect(result.limit).toBe(100);
    });

    it('applies tag filter', async () => {
        await service.get(UNAUTHED, { tag: 'ai' });
        expect(team_repo.count_filtered).toHaveBeenCalled();
    });

    it('applies query filter with ILIKE (replaces search)', async () => {
        team_repo.list_filtered.mockResolvedValueOnce([{ id: hub_legacy_uuid(1), name: 'match' }]);
        tag_repo.find_by_team_ids.mockResolvedValueOnce([]);
        const result = await service.get(UNAUTHED, { query: 'match' });
        expect(result.teams).toHaveLength(1);
    });

    it('escapes special LIKE characters in query param', async () => {
        await service.get(UNAUTHED, { query: '50%_off\\' });
        expect(team_repo.list_filtered).toHaveBeenCalledWith(
            expect.anything(),
            50, 0,
            // Default catalog order (most installed), id as tie-breaker.
            [['install_count', 'DESC'], ['id', 'ASC']],
        );
    });
});

describe('team_query_where (teams/get search)', () => {
    const like = (t: string) => ({ [Op.iLike]: `%${t}%` });

    it('plain text matches name, description or scope', () => {
        const w = team_query_where('  MeasureOne ') as Record<symbol, unknown>;
        expect(w[Op.or]).toEqual([{ name: like('MeasureOne') }, { description: like('MeasureOne') }, { scope: like('MeasureOne') }]);
    });

    it('@scope/name (or scope/name) matches the scope and the name', () => {
        expect((team_query_where('@acme/hello') as Record<symbol, unknown>)[Op.and]).toEqual([{ scope: like('acme') }, { name: like('hello') }]);
        expect((team_query_where('acme/') as Record<symbol, unknown>)[Op.and]).toEqual([{ scope: like('acme') }]);
        expect((team_query_where('/hello') as Record<symbol, unknown>)[Op.and]).toEqual([{ name: like('hello') }]);
    });

    it('nothing to search → null', () => {
        expect(team_query_where(undefined)).toBeNull();
        expect(team_query_where('  @ ')).toBeNull();
    });

    it('escapes LIKE characters', () => {
        expect((team_query_where('50%') as Record<symbol, unknown>)[Op.or]).toContainEqual({ scope: like('50\\%') });
    });
});

/* ================================================================
   get with mine: true — my orgs' and member scopes' teams I can see, plus my drafts
   (PLAN-team-visibility §3.2)
   ================================================================ */

describe('TeamsService — get (mine: true)', () => {
    let service: TeamsService;
    let team_repo: ReturnType<typeof make_team_repo>;
    let tag_repo: ReturnType<typeof make_tag_repo>;

    /** Acme's scopes: `acme` (ORG_ADMIN is a member) and `acme-ops` (not assigned). */
    const ACME_SCOPES = [
        { id: 's-acme', slug: 'acme', org_id: hub_legacy_uuid(1) },
        { id: 's-ops', slug: 'acme-ops', org_id: hub_legacy_uuid(1) },
    ];
    const ROWS = [
        { id: hub_legacy_uuid(1), name: 'pub', scope: 'acme', visibility: 'public', listed: 1 },
        { id: hub_legacy_uuid(2), name: 'priv', scope: 'acme', visibility: 'private', listed: 1 },
        { id: hub_legacy_uuid(3), name: 'ops-priv', scope: 'acme-ops', visibility: 'private', listed: 1 },
        { id: hub_legacy_uuid(4), name: 'ops-pub', scope: 'acme-ops', visibility: 'public', listed: 0 },
        { id: hub_legacy_uuid(5), name: 'someone-elses-draft', scope: 'acme', visibility: 'draft', listed: 0 },
    ];

    beforeEach(async () => {
        vi.clearAllMocks();
        const built = build_service();
        service = built.service;
        team_repo = built.team_repo;
        tag_repo = built.tag_repo;
        const { Scope } = await import('../../../src/models/index.js');
        vi.mocked(Scope.findAll).mockResolvedValue(ACME_SCOPES as never);
    });

    it('returns 401 when unauthenticated', async () => {
        await expect(service.get(UNAUTHED, { mine: true }))
            .rejects.toThrow('Authentication required');
    });

    it("my orgs' scopes: public teams and private ones of scopes I'm a member of; never others' drafts", async () => {
        team_repo.list_by_scope_list.mockResolvedValueOnce(ROWS);
        tag_repo.find_by_team_ids.mockResolvedValueOnce([{ team_id: hub_legacy_uuid(1), tag: 'ai' }]);
        const result = await service.get(ORG_ADMIN, { mine: true });
        expect(team_repo.list_by_scope_list).toHaveBeenCalledWith(['acme', 'acme-ops']);
        expect(result.teams.map((t: { name: string }) => t.name)).toEqual(['pub', 'priv', 'ops-pub']);
        expect(result.tag_map.get(hub_legacy_uuid(1))).toEqual(['ai']);
    });

    it('my own drafts are added, wherever they live', async () => {
        team_repo.list_by_scope_list.mockResolvedValueOnce([]);
        team_repo.find_all_q.mockResolvedValueOnce([{ id: hub_legacy_uuid(9), name: 'wip', scope: 'elsewhere', visibility: 'draft' }]);
        const result = await service.get(ORG_ADMIN, { mine: true });
        expect(result.teams.map((t: { name: string }) => t.name)).toEqual(['wip']);
    });

    it("a scope's page ({ scope, mine }): that scope's teams I can see, member or not", async () => {
        team_repo.list_by_scope_list.mockResolvedValueOnce(ROWS.filter((r) => r.scope === 'acme'));
        const result = await service.get(BOB, { mine: true, scope: 'acme' });
        expect(team_repo.list_by_scope_list).toHaveBeenCalledWith(['acme']);
        expect(result.teams.map((t: { name: string }) => t.name)).toEqual(['pub']);
    });

    it("a personal org's scope: its owner sees its private teams", async () => {
        team_repo.list_by_scope_list.mockResolvedValueOnce([{ id: hub_legacy_uuid(6), name: 'mine', scope: 'alice', visibility: 'private', listed: 1 }]);
        const result = await service.get(ALICE, { mine: true, scope: 'alice' });
        expect(result.teams.map((t: { name: string }) => t.name)).toEqual(['mine']);
    });
});

/* ================================================================
   get_by_id  (single team detail — was: get)
   ================================================================ */

describe('TeamsService — get_by_id', () => {
    let service: TeamsService;
    let team_repo: ReturnType<typeof make_team_repo>;
    let version_repo: ReturnType<typeof make_version_repo>;
    let tag_repo: ReturnType<typeof make_tag_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        const built = build_service();
        service = built.service;
        team_repo = built.team_repo;
        version_repo = built.version_repo;
        tag_repo = built.tag_repo;
    });

    it('returns team detail with versions, tags, and roles', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.list_by_team_id.mockResolvedValueOnce([{ version: '1.0.0', changelog: '', published_at: '2025-01-01' }]);
        tag_repo.find_by_team_id.mockResolvedValueOnce([{ tag: 'ai' }]);
        version_repo.find_detail_by_team_and_version.mockResolvedValueOnce({
            id: hub_legacy_uuid(5), workflow_json: '{"phases":[]}', agents_json: '{}',
            readme: 'hello', cliq_version: '0.5', tools: '[]', capability_json: '{}',
        });

        const result = await service.get_by_id(ALICE, { name: 'my-team', scope: 'alice' });
        expect(result.name).toBe('my-team');
        expect(result.tags).toEqual(['ai']);
    });

    it('returns not_found for missing team', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        await expect(service.get_by_id(ALICE, { name: 'ghost' })).rejects.toThrow('Team not found');
    });

    it('returns not_found when access denied by can_view_team', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PRIVATE_TEAM);
        await expect(service.get_by_id(BOB, { name: 'my-team', scope: 'other' })).rejects.toThrow('Team not found');
    });

    it('returns default workflow when no versions exist', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.list_by_team_id.mockResolvedValueOnce([]);
        tag_repo.find_by_team_id.mockResolvedValueOnce([]);

        const result = await service.get_by_id(ALICE, { name: 'my-team', scope: 'alice' });
        expect(result.latest_version).toBe('0.0.0');
        expect(result.workflow).toEqual({ phases: [] });
    });
});

/* ================================================================
   get_by_id with version  (replaces removed get_version)
   ================================================================ */

describe('TeamsService — get_by_id with version', () => {
    let service: TeamsService;
    let team_repo: ReturnType<typeof make_team_repo>;
    let version_repo: ReturnType<typeof make_version_repo>;
    let tag_repo: ReturnType<typeof make_tag_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        const built = build_service();
        service = built.service;
        team_repo = built.team_repo;
        version_repo = built.version_repo;
        tag_repo = built.tag_repo;
    });

    it('returns team detail for a specific version', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.list_by_team_id.mockResolvedValueOnce([
            { version: '1.0.0', changelog: 'v1', published_at: '2025-01-01' },
        ]);
        tag_repo.find_by_team_id.mockResolvedValueOnce([]);
        version_repo.find_detail_by_team_and_version.mockResolvedValueOnce({
            id: hub_legacy_uuid(5), workflow_json: '{"phases":[]}', agents_json: '{}',
            readme: 'hello', cliq_version: null, tools: '[]', capability_json: '{}',
            roles_json: '[]', manifest_yaml: '',
        });

        const result = await service.get_by_id(ALICE, { name: 'my-team', scope: 'alice', version: '1.0.0' });
        expect(result.name).toBe('my-team');
        expect(result.latest_version).toBe('1.0.0');
    });

    it('returns not_found for missing version', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.list_by_team_id.mockResolvedValueOnce([
            { version: '1.0.0', changelog: 'v1', published_at: '2025-01-01' },
        ]);
        tag_repo.find_by_team_id.mockResolvedValueOnce([]);
        await expect(service.get_by_id(ALICE, { name: 'my-team', scope: 'alice', version: '9.9.9' }))
            .rejects.toThrow(/not found/i);
    });
});


/* ================================================================
   get_versions  (includes latest_only — replaces get_latest_version)
   ================================================================ */

describe('TeamsService — get_versions', () => {
    let service: TeamsService;
    let team_repo: ReturnType<typeof make_team_repo>;
    let version_repo: ReturnType<typeof make_version_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        const built = build_service();
        service = built.service;
        team_repo = built.team_repo;
        version_repo = built.version_repo;
    });

    it('returns all versions for a team', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.list_by_team_id.mockResolvedValueOnce([
            { version: '2.0.0', changelog: 'v2', published_at: '2025-06-01' },
            { version: '1.0.0', changelog: 'v1', published_at: '2025-01-01' },
        ]);
        const result = await service.get_versions(ALICE, { name: 'my-team', scope: 'alice' });
        expect(result.versions).toHaveLength(2);
        expect(result.versions![0].is_latest).toBe(true);
        expect(result.versions![1].is_latest).toBe(false);
    });

    it('returns latest version only when latest_only is true', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_latest_version.mockResolvedValueOnce('2.1.0');
        const result = await service.get_versions(ALICE, { name: 'my-team', scope: 'alice', latest_only: true });
        expect(result.version).toBe('2.1.0');
    });

    it('returns null version when latest_only but no versions exist', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_latest_version.mockResolvedValueOnce(null);
        const result = await service.get_versions(ALICE, { name: 'my-team', scope: 'alice', latest_only: true });
        expect(result.version).toBeNull();
    });
});


/* ================================================================
   publish
   ================================================================ */

describe('TeamsService — publish', () => {
    let service: TeamsService;
    let team_repo: ReturnType<typeof make_team_repo>;
    let version_repo: ReturnType<typeof make_version_repo>;
    let storage: ReturnType<typeof make_storage>;

    beforeEach(() => {
        vi.clearAllMocks();
        storage = make_storage();
        const built = build_service({ storage, packages_path: '/tmp/packages' });
        service = built.service;
        team_repo = built.team_repo;
        version_repo = built.version_repo;
    });

    it('returns 401 when unauthenticated', async () => {
        await expect(service.publish(UNAUTHED, {
            name: 'my-team', scope: 'alice', version: '1.0.0', data_base64: DATA_BASE64,
        })).rejects.toThrow('Authentication required');
    });

    it('returns 422 for invalid team name', async () => {
        await expect(service.publish(ALICE, {
            name: 'INVALID_NAME!', scope: 'alice', version: '1.0.0', data_base64: DATA_BASE64,
        })).rejects.toThrow('Team name must be');
    });

    it("returns 403 without teams.publish in the scope's org (e.g. a non-cliq user and @cliq)", async () => {
        await expect(service.publish(ALICE, {
            name: 'my-team', scope: 'bob', version: '1.0.0', data_base64: DATA_BASE64,
        })).rejects.toMatchObject({ status: 403, message: "Publishing to @bob needs 'teams.publish' in its org" });
        await expect(service.publish(ALICE, {
            name: 'my-team', scope: 'cliq', version: '1.0.0', data_base64: DATA_BASE64,
        })).rejects.toMatchObject({ status: 403 });
    });

    it("anyone with teams.publish in the scope's org publishes a team someone else wrote", async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce({ ...PUBLIC_TEAM, author_id: hub_legacy_uuid(999) });
        version_repo.find_by_team_and_version.mockResolvedValueOnce(null);
        const result = await service.publish(ALICE, { name: 'my-team', scope: 'alice', version: '2.0.0', data_base64: DATA_BASE64 });
        expect(result.version).toBe('2.0.0');
    });

    it('a new team is private unless published as public', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        const result = await service.publish(ALICE, { name: 'new-team', scope: 'alice', version: '1.0.0', data_base64: DATA_BASE64 });
        expect(result.visibility).toBe('private');
        expect(team_repo.create.mock.calls[0]![5]).toBe('private');

        team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        const pub = await service.publish(ALICE, { name: 'new-team2', scope: 'alice', version: '1.0.0', data_base64: DATA_BASE64, visibility: 'public' });
        expect(pub.visibility).toBe('public');
    });

    it('a republish without visibility keeps the current one, and no event is raised', async () => {
        const { EventSubmitService } = await import('../../../src/services/events_service.js');
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_by_team_and_version.mockResolvedValueOnce(null);
        const result = await service.publish(ALICE, { name: 'my-team', scope: 'alice', version: '2.0.0', data_base64: DATA_BASE64 });
        expect(result.visibility).toBe('public');
        expect(team_repo.update.mock.calls[0]![3]).toBe('public');
        expect(EventSubmitService.submit).not.toHaveBeenCalled();
    });

    it('changing a published team\'s visibility raises team.visibility_changed', async () => {
        const { EventSubmitService } = await import('../../../src/services/events_service.js');
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_by_team_and_version.mockResolvedValueOnce(null);
        await service.publish(ALICE, { name: 'my-team', scope: 'alice', version: '2.0.0', data_base64: DATA_BASE64, visibility: 'private' });
        expect(EventSubmitService.submit).toHaveBeenCalledWith(expect.objectContaining({
            type: 'team.visibility_changed', org_id: 'org-alice', team: 'alice/my-team',
            payload: expect.objectContaining({ from: 'public', to: 'private' }),
        }));
    });

    it('returns 403 when PAT grant lacks teams write', async () => {
        const read_only = {
            ...ALICE,
            token_permissions: {
                domains: { scopes: ['alice'] },
                access: { teams: ['read'] as Array<'read' | 'write' | 'admin'> },
            },
        };
        await expect(service.publish(read_only, {
            name: 'my-team', scope: 'alice', version: '1.0.0', data_base64: DATA_BASE64,
        })).rejects.toThrow('Missing teams:write');
    });

    it('returns 409 for duplicate version', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_by_team_and_version.mockResolvedValueOnce({ id: hub_legacy_uuid(5), version: '1.0.0' });

        await expect(service.publish(ALICE, {
            name: 'my-team', scope: 'alice', version: '1.0.0', data_base64: DATA_BASE64,
        })).rejects.toThrow('Version 1.0.0 already exists');
    });

    it('creates new team successfully with version bump', async () => {
        team_repo.find_by_name_and_scope
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: hub_legacy_uuid(1) });

        const result = await service.publish(ALICE, {
            name: 'new-team', scope: 'alice', bump: 'patch', data_base64: DATA_BASE64,
        });

        expect(result.name).toBe('new-team');
        expect(result.version).toBe('1.0.1');
        expect(team_repo.create).toHaveBeenCalled();
        expect(version_repo.create).toHaveBeenCalled();
        expect(storage.write).toHaveBeenCalled();
        // Stored as a zip even though what was sent isn't one.
        const stored = storage.write.mock.calls[0][1] as Buffer;
        expect([stored[0], stored[1]]).toEqual([0x50, 0x4B]);
    });

    it('a package with a broken dependencies.yml is refused before anything is stored', async () => {
        const parser = await import('../../../src/services/package_parser.js');
        vi.mocked(parser.extract_package).mockResolvedValueOnce({
            team_yml: { phases: [], description: 'test', tools: [], tags: [] } as never,
            manifest_yaml: 'name: t\n', roles: [], readme: '', dependencies_yml: '- name: jq\n',
        });
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        await expect(service.publish(ALICE, { name: 'dep-team', scope: 'alice', bump: 'patch', data_base64: DATA_BASE64 }))
            .rejects.toMatchObject({ status: 422, details: { field: 'dependencies.yml', problems: ['dependency `jq` has no `install` command'] } });
        expect(storage.write).not.toHaveBeenCalled();
    });

    it('updates existing team with explicit version', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_by_team_and_version.mockResolvedValueOnce(null);

        const result = await service.publish(ALICE, {
            name: 'my-team', scope: 'alice', version: '2.0.0', data_base64: DATA_BASE64,
        });

        expect(result.version).toBe('2.0.0');
        expect(result.id).toBe(PUBLIC_TEAM.id);
        expect(team_repo.update).toHaveBeenCalled();
        // Same transaction as update — avoids row-lock deadlock on republish.
        expect(team_repo.update_listed).toHaveBeenCalledWith(PUBLIC_TEAM.id, 1, expect.anything());
        expect(version_repo.create).toHaveBeenCalled();
        const create_args = version_repo.create.mock.calls[0];
        const roles_json_arg = create_args[11];
        expect(JSON.parse(roles_json_arg)).toEqual([{ name: 'dev', content_md: '# Dev' }]);
    });

    it('rejects version older than current latest (regression guard)', async () => {
        // Was the actual production bug: publishing 1.1.0 after 1.1.2
        // existed used to succeed and flipped "latest" to 1.1.0 because
        // "latest" was MAX(published_at). Now: refuse the regression.
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_by_team_and_version.mockResolvedValueOnce(null);
        version_repo.find_latest_version.mockResolvedValueOnce('1.1.2');

        await expect(service.publish(ALICE, {
            name: 'my-team', scope: 'alice', version: '1.1.0', data_base64: DATA_BASE64,
        })).rejects.toThrow(/older than the current latest \(1\.1\.2\)/);
    });

    it('accepts equal-or-greater version (no regression)', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_by_team_and_version.mockResolvedValueOnce(null);
        version_repo.find_latest_version.mockResolvedValueOnce('1.1.2');

        const result = await service.publish(ALICE, {
            name: 'my-team', scope: 'alice', version: '2.0.0', data_base64: DATA_BASE64,
        });
        expect(result.version).toBe('2.0.0');
    });
});


/* ================================================================
   download
   ================================================================ */

describe('TeamsService — download', () => {
    let service: TeamsService;
    let team_repo: ReturnType<typeof make_team_repo>;
    let version_repo: ReturnType<typeof make_version_repo>;
    let storage: ReturnType<typeof make_storage>;
    let download_log_repo: ReturnType<typeof make_download_log_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        storage = make_storage();
        download_log_repo = make_download_log_repo();
        const built = build_service({ storage, download_log_repo });
        service = built.service;
        team_repo = built.team_repo;
        version_repo = built.version_repo;
    });

    it('returns 404 when no versions published', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_latest_package.mockResolvedValueOnce(null);

        await expect(service.download(ALICE, { name: 'my-team', scope: 'alice' }))
            .rejects.toThrow('No versions published');
    });

    it('returns 500 when package data missing', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_latest_package.mockResolvedValueOnce({ version: '1.0.0', package_path: '/pkg' });
        storage.read.mockResolvedValueOnce(null);

        await expect(service.download(ALICE, { name: 'my-team', scope: 'alice' }))
            .rejects.toThrow('Package archive missing');
    });

    it('returns data successfully for latest version', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_latest_package.mockResolvedValueOnce({ version: '1.0.0', package_path: '/pkg' });

        const result = await service.download(ALICE, { name: 'my-team', scope: 'alice' });

        expect(result.filename).toBe('my-team-1.0.0.zip');
        expect(result.data_base64).toBe(Buffer.from('zip-data').toString('base64'));
        expect(download_log_repo.create).toHaveBeenCalled();
    });
});

/* ================================================================
   delete_team
   ================================================================ */

describe('TeamsService — delete_team', () => {
    let service: TeamsService;
    let team_repo: ReturnType<typeof make_team_repo>;
    let version_repo: ReturnType<typeof make_version_repo>;
    let storage: ReturnType<typeof make_storage>;

    beforeEach(() => {
        vi.clearAllMocks();
        storage = make_storage();
        const built = build_service({ storage });
        service = built.service;
        team_repo = built.team_repo;
        version_repo = built.version_repo;
    });

    it('returns 404 for non-existent team', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        await expect(service.delete_team(ALICE, { name: 'ghost' }))
            .rejects.toThrow('Team not found');
    });

    it("returns 403 without teams.publish.delete in the scope's org", async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        await expect(service.delete_team(BOB, { name: 'my-team', scope: 'alice' }))
            .rejects.toMatchObject({ status: 403, message: "Publishing to @alice needs 'teams.publish.delete' in its org" });
    });

    it('the org deletes a team someone else wrote (with teams.publish.delete)', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce({ ...PUBLIC_TEAM, author_id: hub_legacy_uuid(999) });
        await expect(service.delete_team(ALICE, { name: 'my-team', scope: 'alice' })).resolves.toEqual({ deleted: true });
    });

    it('deletes team successfully', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.list_packages_by_team.mockResolvedValueOnce([
            { package_path: '/tmp/packages/my-team-1.0.0.zip' },
        ]);

        const result = await service.delete_team(ALICE, { name: 'my-team', scope: 'alice' });

        expect(result.deleted).toBe(true);
        expect(team_repo.delete_by_id).toHaveBeenCalledWith(hub_legacy_uuid(1), expect.anything());
        expect(storage.delete).toHaveBeenCalled();
    });
});

/* ================================================================
   delete_version
   ================================================================ */

describe('TeamsService — delete_version', () => {
    let service: TeamsService;
    let team_repo: ReturnType<typeof make_team_repo>;
    let version_repo: ReturnType<typeof make_version_repo>;
    let storage: ReturnType<typeof make_storage>;

    beforeEach(() => {
        vi.clearAllMocks();
        storage = make_storage();
        const built = build_service({ storage });
        service = built.service;
        team_repo = built.team_repo;
        version_repo = built.version_repo;
    });

    it('returns 404 for non-existent version', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_id_and_package.mockResolvedValueOnce(null);

        await expect(service.delete_version(ALICE, { name: 'my-team', scope: 'alice', version: '9.9.9' }))
            .rejects.toThrow('Version 9.9.9 not found');
    });

    it('deletes version successfully', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_id_and_package.mockResolvedValueOnce({ id: hub_legacy_uuid(5), package_path: '/tmp/pkg.zip' });

        const result = await service.delete_version(ALICE, { name: 'my-team', scope: 'alice', version: '1.0.0' });

        expect(result.deleted).toBe(true);
        expect(result.version).toBe('1.0.0');
        expect(version_repo.delete_by_id).toHaveBeenCalledWith(hub_legacy_uuid(5));
        expect(storage.delete).toHaveBeenCalled();
    });
});

/* ================================================================
   unpublish  (replaces set_listed listed=false)
   ================================================================ */

describe('TeamsService — unpublish', () => {
    let service: TeamsService;
    let team_repo: ReturnType<typeof make_team_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        const built = build_service();
        service = built.service;
        team_repo = built.team_repo;
    });

    it('returns 401 when unauthenticated', async () => {
        await expect(service.unpublish(UNAUTHED, { name: 'my-team' }))
            .rejects.toThrow(/Authentication required|unauthorized/i);
    });

    it('returns 404 for non-existent team', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        await expect(service.unpublish(ALICE, { name: 'ghost' }))
            .rejects.toThrow(/Team not found|not found/i);
    });

    it('unpublishes team to draft', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce({ ...PUBLIC_TEAM, listed: 1 });
        const result = await service.unpublish(ALICE, { name: 'my-team', scope: 'alice' });
        expect(result.status).toBe('draft');
        expect(result.listed).toBe(false);
        // Back to draft inside the same transaction that takes it off realms' team lists.
        expect(team_repo.update_visibility_and_listed.mock.calls[0].slice(0, 3)).toEqual([hub_legacy_uuid(1), 'draft', 0]);
    });

    it('admin can unpublish by team_id with audit', async () => {
        const audit_repo = make_audit_repo();
        const admin_built = build_service({ audit_repo });
        admin_built.team_repo.find_by_id.mockResolvedValueOnce({ ...PUBLIC_TEAM });

        const result = await admin_built.service.unpublish(SITE_ADMIN, { team_id: hub_legacy_uuid(1) });

        expect(result.status).toBe('draft');
        expect(result.listed).toBe(false);
        expect(audit_repo.create).toHaveBeenCalled();
    });
});


/* ================================================================
   rename_team
   ================================================================ */

describe('TeamsService — rename_team', () => {
    let service: TeamsService;
    let team_repo: ReturnType<typeof make_team_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        const built = build_service();
        service = built.service;
        team_repo = built.team_repo;
    });

    it('returns 404 for non-existent team', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        await expect(service.rename_team(ALICE, { name: 'ghost', scope: 'alice', new_name: 'renamed' }))
            .rejects.toThrow('Team not found');
    });

    it('returns 409 when name conflict', async () => {
        team_repo.find_by_name_and_scope
            .mockResolvedValueOnce(PUBLIC_TEAM)
            .mockResolvedValueOnce({ id: hub_legacy_uuid(2), name: 'taken' });

        await expect(service.rename_team(ALICE, { name: 'my-team', scope: 'alice', new_name: 'taken' }))
            .rejects.toThrow('already exists');
    });

    it('renames successfully', async () => {
        team_repo.find_by_name_and_scope
            .mockResolvedValueOnce(PUBLIC_TEAM)
            .mockResolvedValueOnce(null);

        const result = await service.rename_team(ALICE, { name: 'my-team', scope: 'alice', new_name: 'renamed' });

        expect(result).toEqual({ id: hub_legacy_uuid(1), name: 'renamed', scope: 'alice' });
        expect(team_repo.update_name).toHaveBeenCalledWith(hub_legacy_uuid(1), 'renamed');
    });
});
