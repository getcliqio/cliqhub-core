import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { Op } from 'sequelize';
import { TeamsService, team_query_where } from '../../../src/services/teams_service.js';
import { ALICE, BOB, ORG_ADMIN, UNAUTHED, SITE_ADMIN } from '../../helpers/fixtures.js';
import { unpack_bundle } from '@getcliqio/cliq-sdk';

// Version content is read from files (PLAN-team-bundle S1.4b); tests give it per case.
vi.mock('../../../src/services/version_content.js', () => ({
    version_content: vi.fn(async () => null),
    latest_version_content: vi.fn(async () => null),
    version_contents: vi.fn(async () => new Map()),
}));
import { version_content } from '../../../src/services/version_content.js';
import { derive_version_content } from '../../../src/services/package_parser.js';

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
    TeamFile: {},
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
        create: vi.fn().mockResolvedValue(NEW_TEAM_ID),
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

/** Ids repositories hand out: uuids, as storage keys need (S1.2). */
const NEW_TEAM_ID = '0f0f0f0f-1111-4222-8333-444444444444';
const NEW_VERSION_ID = '0e0e0e0e-5555-4666-8777-888888888888';

function make_version_repo() {
    return {
        find_by_team_and_version: vi.fn(),
        find_latest_version: vi.fn(),
        find_latest_ref: vi.fn().mockResolvedValue(null),
        list_by_team_id: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(NEW_VERSION_ID),
        update_package_path: vi.fn().mockResolvedValue(undefined),
        find_package_by_id: vi.fn(),
        create_draft: vi.fn().mockResolvedValue('0d0d0d0d-1111-4222-8333-555555555555'),
        find_draft: vi.fn().mockResolvedValue(null),
        find_open_draft: vi.fn().mockResolvedValue(null),
        touch_draft: vi.fn().mockResolvedValue(undefined),
        delete_draft: vi.fn().mockResolvedValue(true),
        publish_draft: vi.fn().mockResolvedValue(true),
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
    // Folders in memory, so a draft reads back what was written.
    const folders = new Map<string, Record<string, string>>();
    return {
        write: vi.fn().mockResolvedValue(undefined),
        read: vi.fn().mockResolvedValue(Buffer.from('zip-data')),
        delete: vi.fn().mockResolvedValue(undefined),
        write_files: vi.fn(async (prefix: string, files: Record<string, string>) => { folders.set(prefix, { ...files }); }),
        read_files: vi.fn(async (prefix: string) => ({ ...(folders.get(prefix) ?? {}) })),
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

/** A team's files as a publish sends them (S1.3a: publish takes files only). */
const FILES = {
    'team.yml': 'name: t\ndescription: test\ntags: [ai]\nphases: []\n',
    'roles/dev.md': '# Dev',
    'README.md': '# README',
};

/* ─── Helper to build service with all repos ─────────────────── */

/** team_files in memory, by version (PLAN-team-bundle S1.3b). */
function make_file_repo() {
    const rows: Array<Record<string, unknown>> = [];
    return {
        rows,
        list_by_version: vi.fn(async (version_id: string) => rows.filter((r) => r.version_id === version_id)),
        replace_paths: vi.fn(async (version_id: string, add: Array<Record<string, unknown>>) => {
            const paths = add.map((r) => r.path);
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i].version_id === version_id && paths.includes(rows[i].path)) rows.splice(i, 1);
            rows.push(...add);
        }),
        delete_paths: vi.fn(async (version_id: string, paths: string[]) => {
            const before = rows.length;
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i].version_id === version_id && paths.includes(rows[i].path as string)) rows.splice(i, 1);
            return before - rows.length;
        }),
    };
}

function build_service(overrides: {
    team_repo?: ReturnType<typeof make_team_repo>;
    version_repo?: ReturnType<typeof make_version_repo>;
    tag_repo?: ReturnType<typeof make_tag_repo>;
    download_log_repo?: ReturnType<typeof make_download_log_repo>;
    storage?: ReturnType<typeof make_storage>;
    packages_path?: string;
    scope_repo?: ReturnType<typeof make_scope_repo>;
    audit_repo?: ReturnType<typeof make_audit_repo>;
    file_repo?: ReturnType<typeof make_file_repo>;
} = {}) {
    const team_repo = overrides.team_repo ?? make_team_repo();
    const version_repo = overrides.version_repo ?? make_version_repo();
    const tag_repo = overrides.tag_repo ?? make_tag_repo();
    const service = new TeamsService(
        team_repo as any, version_repo as any, tag_repo as any,
        overrides.download_log_repo as any, overrides.storage as any,
        overrides.packages_path, overrides.scope_repo as any, overrides.audit_repo as any,
        (overrides.file_repo ?? make_file_repo()) as any,
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

describe('TeamsService — create, update, the open draft (S1.3c)', () => {
    let service: TeamsService;
    let team_repo: ReturnType<typeof make_team_repo>;
    let version_repo: ReturnType<typeof make_version_repo>;
    let storage: ReturnType<typeof make_storage>;
    let files: ReturnType<typeof make_file_repo>;
    const DRAFT = '0d0d0d0d-1111-4222-8333-555555555555';
    const written = new Map<string, Buffer>();

    beforeEach(() => {
        vi.clearAllMocks();
        written.clear();
        storage = make_storage();
        storage.write.mockImplementation(async (k: string, d: Buffer) => { written.set(k, d); });
        storage.read.mockImplementation(async (k: string) => written.get(k) ?? null);
        files = make_file_repo();
        const built = build_service({ storage, file_repo: files });
        service = built.service;
        team_repo = built.team_repo;
        version_repo = built.version_repo;
        team_repo.find_by_name_and_scope.mockResolvedValue(null);
    });

    const text_of = (path: string) => written.get([...files.rows].reverse().find((r) => r.path === path)!.storage_key as string)!.toString();

    it('create makes the team and its first draft, seeded with team.yml and README.md', async () => {
        const out = await service.create(ALICE, { name: 'loan-review', scope: 'alice', description: 'Reviews loans' });
        expect(out).toMatchObject({ id: NEW_TEAM_ID, status: 'draft', version: null, version_id: DRAFT });
        expect(team_repo.create.mock.calls[0]![5]).toBe('draft');
        expect(files.rows.map((r) => r.path).sort()).toEqual(['README.md', 'team.yml']);
        expect(text_of('team.yml')).toBe('name: "@alice/loan-review"\ndescription: "Reviews loans"\nphases: []\n');
        expect(text_of('README.md')).toBe('# @alice/loan-review\n\nReviews loans\n');
        expect(version_repo.touch_draft).toHaveBeenCalledWith(DRAFT, expect.anything());
    });

    it("a fork's draft starts from the origin version's files, named for the fork", async () => {
        const ORIGIN_VERSION = '0a0a0a0a-1111-4222-8333-444444444444';
        team_repo.find_by_id.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_latest_version.mockResolvedValueOnce('1.0.0');
        version_repo.find_by_team_and_version.mockResolvedValueOnce({ id: ORIGIN_VERSION });
        // the origin version's files (PLAN-team-bundle S1.4b: a fork copies files, not columns)
        const origin = { 'team.yml': 'name: "@alice/my-team"\nphases: []\n', 'roles/dev.md': '# Dev', 'README.md': '# my-team' };
        for (const [p, text] of Object.entries(origin)) {
            const key = `teams/${PUBLIC_TEAM.id}/files/${p}`;
            written.set(key, Buffer.from(text));
            files.rows.push({ id: p, version_id: ORIGIN_VERSION, path: p, storage_key: key, size: text.length, sha256: createHash('sha256').update(text).digest('hex') });
        }
        await service.create(ALICE, { name: 'my-fork', scope: 'alice', forked_from: { team_id: PUBLIC_TEAM.id } });
        const fork_rows = files.rows.filter((r) => r.version_id !== ORIGIN_VERSION);
        expect(fork_rows.map((r) => r.path).sort()).toEqual(['README.md', 'roles/dev.md', 'team.yml']);
        expect(text_of('team.yml')).toContain('name: "@alice/my-fork"');
        expect(text_of('roles/dev.md')).toBe('# Dev');
        expect(team_repo.set_fork_origin).toHaveBeenCalledWith(NEW_TEAM_ID, PUBLIC_TEAM.id, '1.0.0', expect.anything());
    });

    it('a name that exists is refused before anything is stored', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        await expect(service.create(ALICE, { name: 'my-team', scope: 'alice' })).rejects.toMatchObject({ status: 409 });
        expect(storage.write).not.toHaveBeenCalled();
    });

    it("update: discard deletes the named draft; a published version or another team's draft is not found", async () => {
        team_repo.find_by_id.mockResolvedValue(PUBLIC_TEAM);
        version_repo.find_draft.mockResolvedValueOnce({ id: DRAFT, team_id: PUBLIC_TEAM.id });
        await service.update(ALICE, { team_id: PUBLIC_TEAM.id, save_as: 'discard', version_id: DRAFT });
        expect(version_repo.delete_draft).toHaveBeenCalledWith(DRAFT);
        version_repo.find_draft.mockResolvedValueOnce(null);
        await expect(service.update(ALICE, { team_id: PUBLIC_TEAM.id, save_as: 'discard', version_id: DRAFT })).rejects.toMatchObject({ status: 404 });
        await expect(service.update(ALICE, { team_id: PUBLIC_TEAM.id, save_as: 'discard' })).rejects.toMatchObject({ status: 422 });
    });

    it('update changes the description', async () => {
        team_repo.find_by_id.mockResolvedValue(PUBLIC_TEAM);
        await service.update(ALICE, { team_id: PUBLIC_TEAM.id, description: 'New words' });
        expect(team_repo.update_description).toHaveBeenCalledWith(PUBLIC_TEAM.id, 'New words');
    });

    it('files/get with content returns each file\'s text, checked against its sha256', async () => {
        await service.create(ALICE, { name: 'loan-review', scope: 'alice', description: 'x' });
        team_repo.find_by_id.mockResolvedValue({ ...PUBLIC_TEAM, id: NEW_TEAM_ID });
        version_repo.find_draft.mockResolvedValue({ id: DRAFT, team_id: NEW_TEAM_ID });
        const listed = await service.get_files(ALICE, { team_id: NEW_TEAM_ID, version_id: DRAFT, content: true });
        expect(Object.fromEntries(listed.files.map((f) => [f.path, f.content]))).toEqual({
            'README.md': '# @alice/loan-review\n\nx\n', 'team.yml': 'name: "@alice/loan-review"\ndescription: "x"\nphases: []\n',
        });
    });
});

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
        version_repo.find_by_team_and_version.mockResolvedValueOnce({ id: hub_legacy_uuid(5) });
        // what the version's files say (PLAN-team-bundle S1.4b)
        const team_yml = 'name: "@alice/my-team"\ncliq_version: "0.5"\ninputs:\n  - name: note\n    required: false\nagents:\n  exec: {}\nphases:\n  - name: say\n    agent: exec\n';
        vi.mocked(version_content).mockResolvedValueOnce({
            version_id: hub_legacy_uuid(5),
            ...derive_version_content({ 'team.yml': team_yml, 'README.md': 'hello', 'roles/say.md': 'Say it.', 'dependencies.yml': '- name: jq\n' }),
        });

        const result = await service.get_by_id(ALICE, { name: 'my-team', scope: 'alice' });
        expect(result.name).toBe('my-team');
        expect(result.tags).toEqual(['ai']);
        expect(vi.mocked(version_content)).toHaveBeenCalledWith(hub_legacy_uuid(5));
        expect(result).toMatchObject({
            version_id: hub_legacy_uuid(5), raw_manifest: team_yml, readme: 'hello', cliq_version: '0.5',
            agents: { exec: {} }, roles: [{ name: 'say', content_md: 'Say it.' }], dependencies: '- name: jq\n',
            workflow: { phases: [{ name: 'say', agent: 'exec' }] },
            inputs: [expect.objectContaining({ name: 'note', required: false })],
        });
        expect(result).not.toHaveProperty('team_json');
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
        expect(result.version_id).toBeNull();
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
        version_repo.find_by_team_and_version.mockResolvedValueOnce({ id: hub_legacy_uuid(5) });

        const result = await service.get_by_id(ALICE, { name: 'my-team', scope: 'alice', version: '1.0.0' });
        expect(version_repo.find_by_team_and_version).toHaveBeenCalledWith(PUBLIC_TEAM.id, '1.0.0');
        expect(result.version_id).toBe(hub_legacy_uuid(5));
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
    let version_repo: ReturnType<typeof make_version_repo> & Record<string, ReturnType<typeof vi.fn>>;
    let storage: ReturnType<typeof make_storage>;
    let files: ReturnType<typeof make_file_repo>;
    const DRAFT = '0d0d0d0d-1111-4222-8333-555555555555';
    const DRAFT_TEAM = { ...PUBLIC_TEAM, visibility: 'draft' as const };
    const objects = new Map<string, Buffer>();

    /** Stage a draft of PUBLIC_TEAM: rows in team_files, bytes in storage (what teams/files/upload leaves). */
    function stage(team_files: Record<string, string>, team_id = PUBLIC_TEAM.id) {
        files.rows.length = 0;
        let n = 0;
        for (const [p, text] of Object.entries(team_files)) {
            const data = Buffer.from(text);
            const key = `teams/${team_id}/files/${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`;
            objects.set(key, data);
            files.rows.push({ id: key.split('/').pop(), team_id, version_id: DRAFT, path: p, name: p.split('/').pop(), size: data.length,
                sha256: createHash('sha256').update(data).digest('hex'), content_type: 'text/plain', storage_key: key });
        }
    }

    beforeEach(() => {
        vi.clearAllMocks();
        objects.clear();
        storage = make_storage();
        storage.read.mockImplementation(async (key: string) => objects.get(key) ?? null);
        files = make_file_repo();
        const built = build_service({ storage, packages_path: '/tmp/packages', file_repo: files });
        service = built.service;
        team_repo = built.team_repo;
        version_repo = Object.assign(built.version_repo, {
            find_draft: vi.fn().mockResolvedValue({ id: DRAFT, team_id: PUBLIC_TEAM.id }),
            publish_draft: vi.fn().mockResolvedValue(true),
        });
        stage(FILES);
    });

    const publish = (extra: Record<string, unknown> = {}) =>
        service.publish(ALICE, { name: 'my-team', scope: 'alice', version: '2.0.0', version_id: DRAFT, ...extra });

    it('returns 401 when unauthenticated', async () => {
        await expect(service.publish(UNAUTHED, { name: 'my-team', scope: 'alice', version: '1.0.0', version_id: DRAFT })).rejects.toThrow('Authentication required');
    });

    it('returns 422 for invalid team name', async () => {
        await expect(service.publish(ALICE, { name: 'INVALID_NAME!', scope: 'alice', version: '1.0.0', version_id: DRAFT })).rejects.toThrow('Team name must be');
    });

    it("returns 403 without teams.publish in the scope's org (e.g. a non-cliq user and @cliq)", async () => {
        await expect(service.publish(ALICE, { name: 'my-team', scope: 'bob', version: '1.0.0', version_id: DRAFT }))
            .rejects.toMatchObject({ status: 403, message: "Publishing to @bob needs 'teams.publish' in its org" });
        await expect(service.publish(ALICE, { name: 'my-team', scope: 'cliq', version: '1.0.0', version_id: DRAFT })).rejects.toMatchObject({ status: 403 });
    });

    it('returns 403 when PAT grant lacks teams write', async () => {
        const read_only = { ...ALICE, token_permissions: { domains: { scopes: ['alice'] }, access: { teams: ['read'] as Array<'read' | 'write' | 'admin'> } } };
        await expect(service.publish(read_only, { name: 'my-team', scope: 'alice', version: '1.0.0', version_id: DRAFT })).rejects.toThrow('Missing teams:write');
    });

    it('publishing a draft only flips it: no version row is created, no bytes are written (the zip comes on first download)', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        const result = await publish({ changelog: 'first' });
        expect(result).toMatchObject({ id: PUBLIC_TEAM.id, version: '2.0.0', status: 'published' });
        // the version is its files (PLAN-team-bundle S1.5): publish sets only the number and the notes
        expect(version_repo.publish_draft).toHaveBeenCalledWith(DRAFT, { version: '2.0.0', changelog: 'first' }, expect.anything());
        expect(storage.write).not.toHaveBeenCalled();
        // Same transaction as update — avoids row-lock deadlock on republish.
        expect(team_repo.update_listed).toHaveBeenCalledWith(PUBLIC_TEAM.id, 1, expect.anything());
    });

    it("anyone with teams.publish in the scope's org publishes a team someone else wrote", async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce({ ...PUBLIC_TEAM, author_id: hub_legacy_uuid(999) });
        expect((await publish()).version).toBe('2.0.0');
    });

    it('a team still in draft is published private unless published as public', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(DRAFT_TEAM);
        expect((await publish({ version: '1.0.0' })).visibility).toBe('private');
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(DRAFT_TEAM);
        expect((await publish({ version: '1.0.1', visibility: 'public' })).visibility).toBe('public');
    });

    it('a republish without visibility keeps the current one, and no event is raised', async () => {
        const { EventSubmitService } = await import('../../../src/services/events_service.js');
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        expect((await publish()).visibility).toBe('public');
        expect(team_repo.update.mock.calls[0]![3]).toBe('public');
        expect(EventSubmitService.submit).not.toHaveBeenCalled();
    });

    it("changing a published team's visibility raises team.visibility_changed", async () => {
        const { EventSubmitService } = await import('../../../src/services/events_service.js');
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        await publish({ visibility: 'private' });
        expect(EventSubmitService.submit).toHaveBeenCalledWith(expect.objectContaining({
            type: 'team.visibility_changed', org_id: 'org-alice', team: 'alice/my-team',
            payload: expect.objectContaining({ from: 'public', to: 'private' }),
        }));
    });

    it('an unknown team, or a draft that is not this team\'s (or already published), is not found', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        await expect(publish()).rejects.toMatchObject({ status: 404 });
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_draft.mockResolvedValueOnce(null);
        await expect(publish()).rejects.toThrow('Draft not found');
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_draft.mockResolvedValueOnce({ id: DRAFT, team_id: hub_legacy_uuid(77) });
        await expect(publish()).rejects.toThrow('Draft not found');
        expect(version_repo.publish_draft).not.toHaveBeenCalled();
    });

    it('returns 409 for a version that exists, and refuses one older than the latest', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_by_team_and_version.mockResolvedValueOnce({ id: hub_legacy_uuid(5), version: '2.0.0' });
        await expect(publish()).rejects.toThrow('Version 2.0.0 already exists');
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_latest_version.mockResolvedValueOnce('2.1.0');
        await expect(publish()).rejects.toThrow(/older than the current latest \(2\.1\.0\)/);
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_latest_version.mockResolvedValueOnce('1.9.0');
        expect((await publish()).version).toBe('2.0.0');
    });

    it('a draft whose files are wrong is refused, and stays a draft', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValue(PUBLIC_TEAM);
        stage({ ...FILES, 'dependencies.yml': '- name: jq\n' });
        await expect(publish()).rejects.toMatchObject({ status: 422, details: { field: 'dependencies.yml', problems: ['dependency `jq` has no `install` command'] } });
        stage({ 'README.md': '# x' });
        await expect(publish()).rejects.toThrow('valid team.yml');
        stage({ ...FILES, 'roles/bin.md': 'PK\u0000\u0003' });
        await expect(publish()).rejects.toMatchObject({ status: 422, details: { paths: ['roles/bin.md'] } });
        expect(version_repo.publish_draft).not.toHaveBeenCalled();
    });

    it('a stored file that does not match its record stops the publish', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        objects.set(files.rows[0].storage_key as string, Buffer.from('tampered'));
        await expect(publish()).rejects.toThrow("don't match their record");
        expect(version_repo.publish_draft).not.toHaveBeenCalled();
    });
});

/* ================================================================
   download
   ================================================================ */

describe('TeamsService — team files (S1.3b)', () => {
    let service: TeamsService;
    let team_repo: ReturnType<typeof make_team_repo>;
    let version_repo: ReturnType<typeof make_version_repo> & { create_draft: ReturnType<typeof vi.fn>; find_draft: ReturnType<typeof vi.fn> };
    let storage: ReturnType<typeof make_storage>;
    let files: ReturnType<typeof make_file_repo>;
    const DRAFT = '0d0d0d0d-1111-4222-8333-555555555555';
    const yml = { path: 'team.yml', content_type: 'text/yaml', data: Buffer.from('name: x\n') };
    const png = { path: 'roles/brief.md', content_type: 'text/markdown', data: Buffer.from('# Brief') };

    beforeEach(() => {
        vi.clearAllMocks();
        storage = make_storage();
        files = make_file_repo();
        const built = build_service({ storage, file_repo: files });
        service = built.service;
        team_repo = built.team_repo;
        version_repo = Object.assign(built.version_repo, {
            create_draft: vi.fn().mockResolvedValue(DRAFT),
            find_draft: vi.fn().mockResolvedValue({ id: DRAFT, team_id: PUBLIC_TEAM.id }),
        });
        team_repo.find_by_id.mockResolvedValue(PUBLIC_TEAM);
    });

    it('without a version_id, starts a draft; each file gets an id, its bytes stored under it, and a row', async () => {
        const out = await service.upload_files(ALICE, { team_id: PUBLIC_TEAM.id, files: [yml, png] });
        expect(version_repo.create_draft).toHaveBeenCalledWith(PUBLIC_TEAM.id, expect.anything());
        expect(out.version_id).toBe(DRAFT);
        expect(out.files.map((f) => f.path)).toEqual(['team.yml', 'roles/brief.md']);
        for (const f of out.files) {
            expect(storage.write).toHaveBeenCalledWith(`teams/${PUBLIC_TEAM.id}/files/${f.id}`, expect.any(Buffer), expect.any(String));
        }
        expect(files.rows.map((r) => [r.path, r.version_id, r.size])).toEqual([['team.yml', DRAFT, 8], ['roles/brief.md', DRAFT, 7]]);
        expect(files.rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('with a version_id, adds to that draft and replaces a path it already has', async () => {
        await service.upload_files(ALICE, { team_id: PUBLIC_TEAM.id, version_id: DRAFT, files: [yml] });
        await service.upload_files(ALICE, { team_id: PUBLIC_TEAM.id, version_id: DRAFT, files: [{ ...yml, data: Buffer.from('name: y\n') }, png] });
        expect(version_repo.create_draft).not.toHaveBeenCalled();
        expect(files.rows.map((r) => r.path).sort()).toEqual(['roles/brief.md', 'team.yml']);
        expect(storage.write).toHaveBeenCalledTimes(3);
    });

    it('a published version (or another team\'s draft) cannot take files', async () => {
        version_repo.find_draft.mockResolvedValueOnce(null);
        await expect(service.upload_files(ALICE, { team_id: PUBLIC_TEAM.id, version_id: DRAFT, files: [yml] })).rejects.toMatchObject({ status: 404 });
        version_repo.find_draft.mockResolvedValueOnce({ id: DRAFT, team_id: hub_legacy_uuid(77) });
        await expect(service.upload_files(ALICE, { team_id: PUBLIC_TEAM.id, version_id: DRAFT, files: [yml] })).rejects.toMatchObject({ status: 404 });
        expect(storage.write).not.toHaveBeenCalled();
    });

    it('refuses paths that are not team paths, a path twice, and a draft over 10 MB — before storing anything', async () => {
        await expect(service.upload_files(ALICE, { team_id: PUBLIC_TEAM.id, files: [yml, { ...png, path: 'scripts/x.sh' }] })).rejects.toMatchObject({ status: 422, details: { paths: ['scripts/x.sh'] } });
        await expect(service.upload_files(ALICE, { team_id: PUBLIC_TEAM.id, files: [yml, yml] })).rejects.toMatchObject({ status: 422 });
        await expect(service.upload_files(ALICE, { team_id: PUBLIC_TEAM.id, files: [{ ...yml, data: Buffer.alloc(10 * 1024 * 1024 + 1) }] })).rejects.toThrow('more than 10 MB');
        expect(storage.write).not.toHaveBeenCalled();
    });

    it('remove takes paths out of a draft; get lists a draft\'s files', async () => {
        await service.upload_files(ALICE, { team_id: PUBLIC_TEAM.id, version_id: DRAFT, files: [yml, png] });
        expect(await service.remove_files(ALICE, { team_id: PUBLIC_TEAM.id, version_id: DRAFT, paths: ['roles/brief.md'] })).toEqual({ removed: 1 });
        const listed = await service.get_files(ALICE, { team_id: PUBLIC_TEAM.id, version_id: DRAFT });
        expect(listed.files.map((f) => f.path)).toEqual(['team.yml']);
    });
});

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
        version_repo.find_latest_package.mockResolvedValueOnce({ id: NEW_VERSION_ID, version: '1.0.0', package_path: `teams/${NEW_TEAM_ID}/versions/${NEW_VERSION_ID}.zip` });
        storage.read.mockResolvedValueOnce(null);

        await expect(service.download(ALICE, { name: 'my-team', scope: 'alice' }))
            .rejects.toThrow('Package archive missing');
    });

    it('returns data successfully for latest version', async () => {
        team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        version_repo.find_latest_package.mockResolvedValueOnce({ id: NEW_VERSION_ID, version: '1.0.0', package_path: `teams/${NEW_TEAM_ID}/versions/${NEW_VERSION_ID}.zip` });

        const result = await service.download(ALICE, { name: 'my-team', scope: 'alice' });

        expect(result.filename).toBe('my-team-1.0.0.zip');
        expect(result.data_base64).toBe(Buffer.from('zip-data').toString('base64'));
        expect(download_log_repo.create).toHaveBeenCalled();
    });

    it('reads the version id key; a version without one has no zip (S1.2)', async () => {
        const id_key = `teams/${NEW_TEAM_ID}/versions/${NEW_VERSION_ID}.zip`;
        team_repo.find_by_name_and_scope.mockResolvedValue(PUBLIC_TEAM);
        version_repo.find_latest_package.mockResolvedValueOnce({ id: NEW_VERSION_ID, version: '1.0.0', package_path: id_key });
        await service.download(ALICE, { name: 'my-team', scope: 'alice' });
        expect(storage.read).toHaveBeenLastCalledWith(id_key);
        storage.read.mockClear();
        version_repo.find_latest_package.mockResolvedValueOnce({ id: NEW_VERSION_ID, version: '1.0.0', package_path: 'draft://x/1.0.0' });
        await expect(service.download(ALICE, { name: 'my-team', scope: 'alice' })).rejects.toThrow('Package archive missing');
        expect(storage.read).not.toHaveBeenCalled();
    });

    it('with no cached zip, builds it from the version\'s team_files, stores it, points the version at it (S1.3b)', async () => {
        const files = make_file_repo();
        const objects = new Map<string, Buffer>([['teams/t/files/a', Buffer.from('name: x\n')], ['teams/t/files/b', Buffer.from('# Dev')]]);
        files.rows.push(
            { version_id: NEW_VERSION_ID, path: 'team.yml', storage_key: 'teams/t/files/a', sha256: createHash('sha256').update('name: x\n').digest('hex') },
            { version_id: NEW_VERSION_ID, path: 'roles/dev.md', storage_key: 'teams/t/files/b', sha256: createHash('sha256').update('# Dev').digest('hex') },
        );
        const store = make_storage();
        store.read.mockImplementation(async (k: string) => objects.get(k) ?? null);
        const built = build_service({ storage: store, file_repo: files, download_log_repo });
        built.team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        built.version_repo.find_latest_package.mockResolvedValueOnce({ id: NEW_VERSION_ID, version: '1.0.0', package_path: '' });
        const result = await built.service.download(ALICE, { name: 'my-team', scope: 'alice' });
        const key = `teams/${PUBLIC_TEAM.id}/versions/${NEW_VERSION_ID}.zip`;
        expect(store.write).toHaveBeenCalledWith(key, expect.any(Buffer));
        expect(built.version_repo.update_package_path).toHaveBeenCalledWith(NEW_VERSION_ID, key);
        expect((await unpack_bundle(Buffer.from(result.data_base64, 'base64'))).files).toEqual({ 'team.yml': 'name: x\n', 'roles/dev.md': '# Dev' });
    });

    it('downloads by version_id and answers with it (S1.2)', async () => {
        version_repo.find_package_by_id.mockResolvedValueOnce({ id: NEW_VERSION_ID, team_id: PUBLIC_TEAM.id, version: '1.2.0', package_path: `teams/${PUBLIC_TEAM.id}/versions/${NEW_VERSION_ID}.zip` });
        team_repo.find_by_id.mockResolvedValueOnce(PUBLIC_TEAM);
        const result = await service.download(ALICE, { version_id: NEW_VERSION_ID });
        expect(result).toMatchObject({ version: '1.2.0', version_id: NEW_VERSION_ID });
        expect(team_repo.find_by_name_and_scope).not.toHaveBeenCalled();
    });

    it('an unknown version_id, or one of a team the caller can\'t see, is not found', async () => {
        version_repo.find_package_by_id.mockResolvedValueOnce(null);
        await expect(service.download(ALICE, { version_id: NEW_VERSION_ID })).rejects.toThrow('Version not found');
        version_repo.find_package_by_id.mockResolvedValueOnce({ id: NEW_VERSION_ID, team_id: PRIVATE_TEAM.id, version: '1.0.0', package_path: 'x.zip' });
        team_repo.find_by_id.mockResolvedValueOnce(PRIVATE_TEAM);
        await expect(service.download(UNAUTHED, { version_id: NEW_VERSION_ID })).rejects.toThrow('Version not found');
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
            { package_path: `teams/${NEW_TEAM_ID}/versions/${NEW_VERSION_ID}.zip` },
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
        version_repo.find_id_and_package.mockResolvedValueOnce({ id: hub_legacy_uuid(5), package_path: `teams/${NEW_TEAM_ID}/versions/${NEW_VERSION_ID}.zip` });

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
