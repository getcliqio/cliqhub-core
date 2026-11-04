import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import { createHash } from 'node:crypto';
import request from 'supertest';
import { stub_pat_auth, TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';

import express from 'express';
import { create_auth_middleware } from '../../src/middleware/auth_middleware.js';
import { AuthService } from '../../src/services/auth_service.js';
import { TeamsService } from '../../src/services/teams_service.js';
import { AuthController } from '../../src/controllers/auth_controller.js';
import { TeamsController } from '../../src/controllers/teams_controller.js';
import { error_handler } from '../../src/middleware/error_handler.js';
import { make_mock_repos, test_config } from '../helpers/test_container.js';

vi.mock('../../src/services/package_parser.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/services/package_parser.js')>();
    return {
        ...actual,
        extract_package: vi.fn().mockResolvedValue({
            team_yml: { phases: [], description: 'test', tools: [] },
            roles: [], readme: '',
        }),
        normalize_tags: vi.fn().mockImplementation((t: string[]) => t),
    };
});

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hash'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

const SECRET = 'test-secret';
const config = test_config();
const repos = make_mock_repos();

const mock_storage = {
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(Buffer.from('zip-data')),
    delete: vi.fn().mockResolvedValue(undefined),
};
/** A version's files (PLAN-team-bundle S1.3b): a draft's team.yml is set per test by `with_draft`. */
const file_repo = { list_by_version: vi.fn().mockResolvedValue([]) };
// Draft and withdraw lookups the shared mock repos predate (PLAN-team-bundle S1.3b, S2).
Object.assign(repos.version_repo, { find_draft: vi.fn(), publish_draft: vi.fn(), find_highest_version: vi.fn(), withdraw: vi.fn() });
const version_repo = repos.version_repo as typeof repos.version_repo
    & Record<'find_draft' | 'publish_draft' | 'find_highest_version' | 'withdraw', ReturnType<typeof vi.fn>>;

const app = express();
app.use(express.json());

app.use(create_auth_middleware({
    user_repo: repos.user_repo as any,
    token_repo: repos.token_repo as any,
    scope_repo: repos.scope_repo as any,
    org_member_repo: repos.org_member_repo as any,
}));

const auth_service = new AuthService(
    repos.user_repo as any, repos.scope_repo as any, repos.org_member_repo as any,
    config, repos.org_repo as any, repos.token_repo as any,
);
const auth_controller = new AuthController(auth_service);

app.post('/internal/auth/signup', auth_controller.wrap(auth_controller.signup));
app.post('/internal/auth/authenticate_user', auth_controller.wrap(auth_controller.authenticate_user));

const teams_service = new TeamsService(
    repos.team_repo as any, repos.version_repo as any,
    repos.tag_repo as any,
    repos.download_log_repo as any, mock_storage as any, '/tmp/test',
    repos.scope_repo as any, repos.audit_repo as any, file_repo as any,
);
const teams_controller = new TeamsController(teams_service);

app.post('/v1/teams/get',            teams_controller.wrap(teams_controller.get));
app.post('/v1/teams/publish',        teams_controller.wrap(teams_controller.publish));
app.post('/v1/teams/download',       teams_controller.wrap(teams_controller.download));
app.post('/v1/teams/delete',         teams_controller.wrap(teams_controller.delete_team));
app.post('/v1/teams/delete_version', teams_controller.wrap(teams_controller.delete_version));
app.post('/v1/teams/create',         teams_controller.wrap(teams_controller.create));
app.post('/v1/teams/update',         teams_controller.wrap(teams_controller.update));
app.post('/v1/teams/unpublish',      teams_controller.wrap(teams_controller.unpublish));

app.use(error_handler);

const ALICE_USER = {
    id: hub_legacy_uuid(1), username: 'alice', display_name: 'alice',
    email: 'alice@test.com', role: 'user',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

const PUBLIC_TEAM = {
    id: hub_legacy_uuid(1), name: 'my-team', scope: 'alice',
    description: 'test', author_id: hub_legacy_uuid(1),
    license: 'MIT', visibility: 'public', listed: 1,
    created_at: '2025-01-01', updated_at: '2025-06-01', install_count: 10,
};

function auth_header(_payload?: { user_id: string; username: string; role: string }) {
    return `Bearer ${TEST_PAT_PLAINTEXT}`;
}

function mock_auth_jwt(user = ALICE_USER) {
    stub_pat_auth(repos, user);
    repos.scope_repo.find_owned_by_user.mockReset();
    const own = { id: hub_legacy_uuid(1), slug: user.username, owner_id: user.id, org_id: null };
    repos.scope_repo.find_owned_by_user.mockResolvedValueOnce([own]);
    // The caller's own (org-less) scope: its owner publishes (PLAN-team-visibility §3.3); any other is
    // an org's scope where the caller holds no role.
    repos.scope_repo.find_by_slug.mockImplementation(async (slug: string) =>
        (slug === user.username ? own : { id: 'x', slug, owner_id: null, org_id: hub_legacy_uuid(500) }));
}

const DRAFT_ID = hub_legacy_uuid(7);

/** Publishing names the team, the version and the draft holding its files (PLAN-team-bundle S1.3b, S2). */
const VALID_PUBLISH_BODY = { name: 'my-team', scope: 'alice', version: '2.0.0', version_id: DRAFT_ID };

/** PUBLIC_TEAM has an open draft whose team.yml already names its scope and `version`. */
function with_draft(version = '2.0.0'): void {
    const yml = Buffer.from(`name: "@alice/my-team"\nversion: "${version}"\ndescription: test\nphases: []\n`, 'utf8');
    version_repo.find_draft.mockResolvedValue({ id: DRAFT_ID, team_id: PUBLIC_TEAM.id, status: 'draft' });
    version_repo.publish_draft.mockResolvedValue(true);
    version_repo.find_highest_version.mockResolvedValue('1.0.0');
    file_repo.list_by_version.mockResolvedValueOnce([{
        id: hub_legacy_uuid(8), version_id: DRAFT_ID, team_id: PUBLIC_TEAM.id, path: 'team.yml', name: 'team.yml',
        size: yml.length, sha256: createHash('sha256').update(yml).digest('hex'), content_type: 'text/yaml', storage_key: 'k/team.yml',
    }]);
    mock_storage.read.mockResolvedValueOnce(yml);
}

// ─── POST /v1/teams/publish ─────────────────────────────────────

describe('POST /v1/teams/publish', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 401 when not authenticated', async () => {
        const res = await request(app).post('/v1/teams/publish').send(VALID_PUBLISH_BODY);
        expect(res.status).toBe(401);
    });

    it('returns 422 for a new team with no files (create it and upload them first)', async () => {
        mock_auth_jwt();
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        const res = await request(app)
            .post('/v1/teams/publish')
            .set('Authorization', auth_header())
            .send({ name: 'my-team', scope: 'alice', version: '1.0.0' });
        expect(res.status).toBe(422);
        expect(res.body.error.message).toMatch(/files are required for new teams/);
    });

    it('returns 422 for a draft published with no version (no bump)', async () => {
        mock_auth_jwt();
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce({ ...PUBLIC_TEAM, author_id: hub_legacy_uuid(1) });
        const res = await request(app)
            .post('/v1/teams/publish')
            .set('Authorization', auth_header())
            .send({ ...VALID_PUBLISH_BODY, version: undefined });
        expect(res.status).toBe(422);
        expect(res.body.error.message).toMatch(/version is required/);
        expect(version_repo.publish_draft).not.toHaveBeenCalled();
    });

    it("returns 200 and publishes the team's draft as the version given", async () => {
        mock_auth_jwt();
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce({ ...PUBLIC_TEAM, author_id: hub_legacy_uuid(1) });
        with_draft('2.0.0');

        const res = await request(app)
            .post('/v1/teams/publish')
            .set('Authorization', auth_header())
            .send(VALID_PUBLISH_BODY);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.data).toMatchObject({ name: 'my-team', version: '2.0.0', version_id: DRAFT_ID });
        expect(version_repo.publish_draft).toHaveBeenCalledWith(DRAFT_ID, expect.objectContaining({ version: '2.0.0' }), expect.anything());
    });

    it('returns 422 for a version lower than the highest so far', async () => {
        mock_auth_jwt();
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce({ ...PUBLIC_TEAM, author_id: hub_legacy_uuid(1) });
        with_draft('0.9.0');
        const res = await request(app)
            .post('/v1/teams/publish')
            .set('Authorization', auth_header())
            .send({ ...VALID_PUBLISH_BODY, version: '0.9.0' });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(version_repo.publish_draft).not.toHaveBeenCalled();
    });

    it('returns 403 when scope not in user scopes', async () => {
        mock_auth_jwt();
        const res = await request(app)
            .post('/v1/teams/publish')
            .set('Authorization', auth_header())
            .send({ ...VALID_PUBLISH_BODY, scope: 'other-org' });
        expect(res.status).toBe(403);
    });
});

// ─── POST /v1/teams/download ────────────────────────────────────

describe('POST /v1/teams/download', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 200 with package data', async () => {
        // The version's zip, cached at the id layout (PLAN-team-bundle S1.2).
        const version_id = hub_legacy_uuid(6);
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        repos.version_repo.find_latest_package.mockResolvedValueOnce({
            id: version_id, version: '1.0.0', package_path: `teams/${PUBLIC_TEAM.id}/versions/${version_id}.zip`,
        });
        repos.download_log_repo.find_by_team_key_date.mockResolvedValueOnce(null);

        const res = await request(app)
            .post('/v1/teams/download')
            .send({ name: 'my-team', scope: 'alice' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.data.filename).toBe('my-team-1.0.0.zip');
        expect(Buffer.from(res.body.data.data_base64, 'base64').toString()).toBe('zip-data');
        expect(res.body.data.version_id).toBe(version_id);
        expect(mock_storage.read).toHaveBeenCalledWith(`teams/${PUBLIC_TEAM.id}/versions/${version_id}.zip`);
    });

    it('returns 404 when team not found', async () => {
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        const res = await request(app)
            .post('/v1/teams/download')
            .send({ name: 'ghost', scope: 'alice' });
        expect(res.status).toBe(404);
    });

    it('returns 404 when no versions published', async () => {
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        repos.version_repo.find_latest_package.mockResolvedValueOnce(null);

        const res = await request(app)
            .post('/v1/teams/download')
            .send({ name: 'my-team', scope: 'alice' });
        expect(res.status).toBe(404);
    });
});

// ─── POST /v1/teams/delete ──────────────────────────────────────

describe('POST /v1/teams/delete', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 401 when not authenticated', async () => {
        const res = await request(app)
            .post('/v1/teams/delete')
            .send({ name: 'my-team' });
        expect(res.status).toBe(401);
    });

    it('returns 404 when team not found', async () => {
        mock_auth_jwt();
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);

        const res = await request(app)
            .post('/v1/teams/delete')
            .set('Authorization', auth_header())
            .send({ name: 'ghost' });
        expect(res.status).toBe(404);
    });

    it('returns 200 and deletes team by name', async () => {
        mock_auth_jwt();
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce({ ...PUBLIC_TEAM, author_id: hub_legacy_uuid(1) });
        repos.version_repo.list_packages_by_team.mockResolvedValueOnce([
            { package_path: '/tmp/test/my-team-1.0.0.zip' },
        ]);

        const res = await request(app)
            .post('/v1/teams/delete')
            .set('Authorization', auth_header())
            .send({ name: 'my-team', scope: 'alice' });
        expect(res.status).toBe(200);
        expect(res.body.data.deleted).toBe(true);
    });
});

// ─── POST /v1/teams/delete_version ──────────────────────────────

describe('POST /v1/teams/delete_version', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 401 when not authenticated', async () => {
        const res = await request(app)
            .post('/v1/teams/delete_version')
            .send({ name: 'my-team', version: '1.0.0' });
        expect(res.status).toBe(401);
    });

    it('returns 404 when team not found', async () => {
        mock_auth_jwt();
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);

        const res = await request(app)
            .post('/v1/teams/delete_version')
            .set('Authorization', auth_header())
            .send({ name: 'ghost', version: '1.0.0' });
        expect(res.status).toBe(404);
    });

    it('returns 200 and withdraws the version (PLAN-team-bundle S2: its files stay)', async () => {
        mock_auth_jwt();
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce({ ...PUBLIC_TEAM, author_id: hub_legacy_uuid(1) });
        repos.version_repo.find_id_and_package.mockResolvedValueOnce({
            id: hub_legacy_uuid(5), package_path: `teams/${PUBLIC_TEAM.id}/versions/${hub_legacy_uuid(5)}.zip`,
        });
        version_repo.withdraw.mockResolvedValueOnce(true);

        const res = await request(app)
            .post('/v1/teams/delete_version')
            .set('Authorization', auth_header())
            .send({ name: 'my-team', scope: 'alice', version: '1.0.0' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.data).toEqual({ withdrawn: true, version: '1.0.0' });
        expect(version_repo.withdraw).toHaveBeenCalledWith(hub_legacy_uuid(5));
        expect(mock_storage.delete).not.toHaveBeenCalled();
    });

    it('returns 409 for a version already withdrawn', async () => {
        mock_auth_jwt();
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce({ ...PUBLIC_TEAM, author_id: hub_legacy_uuid(1) });
        repos.version_repo.find_id_and_package.mockResolvedValueOnce({ id: hub_legacy_uuid(5), package_path: '' });
        version_repo.withdraw.mockResolvedValueOnce(false);
        const res = await request(app)
            .post('/v1/teams/delete_version')
            .set('Authorization', auth_header())
            .send({ name: 'my-team', scope: 'alice', version: '1.0.0' });
        expect(res.status).toBe(409);
    });
});

// ─── POST /v1/teams/unpublish ─────────────────────────────────

describe('POST /v1/teams/unpublish', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 401 without auth', async () => {
        const res = await request(app)
            .post('/v1/teams/unpublish')
            .send({ name: 'my-team', scope: 'alice' });
        expect(res.status).toBe(401);
    });

    it('returns 404 for missing team', async () => {
        mock_auth_jwt();
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        const res = await request(app)
            .post('/v1/teams/unpublish')
            .set('Authorization', auth_header())
            .send({ name: 'ghost', scope: 'alice' });
        expect(res.status).toBe(404);
    });

    it('unpublishes owned team to draft', async () => {
        mock_auth_jwt();
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        repos.team_repo.update_visibility_and_listed.mockResolvedValueOnce(undefined);
        const res = await request(app)
            .post('/v1/teams/unpublish')
            .set('Authorization', auth_header())
            .send({ name: 'my-team', scope: 'alice' });
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('draft');
        expect(res.body.data.listed).toBe(false);
    });
});


// ─── POST /v1/teams/get (mine) ─────────────────────────────────

describe('POST /v1/teams/get (mine=true)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 401 when not authenticated', async () => {
        const res = await request(app)
            .post('/v1/teams/get')
            .send({ mine: true });
        expect(res.status).toBe(401);
    });

    it('returns 200 with teams for user scope', async () => {
        mock_auth_jwt();
        repos.team_repo.list_by_scope_list.mockResolvedValueOnce([
            { id: hub_legacy_uuid(1), name: 'my-team', scope: 'alice', description: 'test',
              author: 'alice', latest_version: '1.0.0', install_count: 5, visibility: 'public' },
        ]);
        repos.tag_repo.find_by_team_ids.mockResolvedValueOnce([{ team_id: hub_legacy_uuid(1), tag: 'ai' }]);

        const res = await request(app)
            .post('/v1/teams/get')
            .set('Authorization', auth_header())
            .send({ mine: true, scope: 'alice' });
        expect(res.status).toBe(200);
        expect(res.body.data.items).toHaveLength(1);
    });
});
