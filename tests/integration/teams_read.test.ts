import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import request from 'supertest';
import { create_test_app } from '../helpers/test_container.js';

const { app, repos } = create_test_app();

const PUBLIC_TEAM = {
    id: hub_legacy_uuid(1), name: 'my-team', scope: 'alice', scope_type: 'user',
    description: 'A test team', author_id: hub_legacy_uuid(1),
    license: 'MIT', visibility: 'public', listed: 1,
    created_at: '2025-01-01', updated_at: '2025-06-01', install_count: 10,
};

describe('POST /v1/teams/get (unified list)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 200 with team list (public, no auth)', async () => {
        repos.team_repo.count_filtered.mockResolvedValueOnce(1);
        repos.team_repo.list_filtered.mockResolvedValueOnce([{
            id: hub_legacy_uuid(1), name: 'my-team', scope: 'alice', description: 'desc',
            author: 'alice', latest_version: '1.0.0', install_count: 10,
        }]);
        repos.tag_repo.find_by_team_ids.mockResolvedValueOnce([{ team_id: hub_legacy_uuid(1), tag: 'ai' }]);

        const res = await request(app).post('/v1/teams/get').send({});
        expect(res.status).toBe(200);
        expect(res.body.data.teams).toHaveLength(1);
        expect(res.body.data.total).toBe(1);
    });

    it('returns 200 with filtered by tag', async () => {
        repos.team_repo.count_filtered.mockResolvedValueOnce(0);
        repos.team_repo.list_filtered.mockResolvedValueOnce([]);
        const res = await request(app).post('/v1/teams/get').send({ tag: 'ai' });
        expect(res.status).toBe(200);
    });

    it('returns 200 with pagination', async () => {
        repos.team_repo.count_filtered.mockResolvedValueOnce(100);
        repos.team_repo.list_filtered.mockResolvedValueOnce([]);
        const res = await request(app).post('/v1/teams/get').send({ limit: 10, offset: 20 });
        expect(res.body.data.limit).toBe(10);
        expect(res.body.data.offset).toBe(20);
    });

    it('returns 200 with text search via query param', async () => {
        repos.team_repo.count_filtered.mockResolvedValueOnce(1);
        repos.team_repo.list_filtered.mockResolvedValueOnce([{
            id: hub_legacy_uuid(1), name: 'match', scope: 'alice', description: 'desc',
            author: 'alice', latest_version: '1.0.0', install_count: 5,
        }]);
        repos.tag_repo.find_by_team_ids.mockResolvedValueOnce([]);
        const res = await request(app).post('/v1/teams/get').send({ query: 'match' });
        expect(res.status).toBe(200);
        expect(res.body.data.teams).toHaveLength(1);
    });

    it('returns 200 with empty search results', async () => {
        repos.team_repo.count_filtered.mockResolvedValueOnce(0);
        repos.team_repo.list_filtered.mockResolvedValueOnce([]);
        const res = await request(app).post('/v1/teams/get').send({ query: 'nope' });
        expect(res.body.data.teams).toEqual([]);
    });
});

describe('POST /v1/teams/get_by_id', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 200 with team detail for public team', async () => {
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        repos.team_repo.find_author_username.mockResolvedValueOnce('alice');
        repos.version_repo.list_by_team_id.mockResolvedValueOnce([{ version: '1.0.0', changelog: '', published_at: '2025-01-01' }]);
        repos.tag_repo.find_by_team_id.mockResolvedValueOnce([{ tag: 'ai' }]);
        repos.version_repo.find_detail_by_team_and_version.mockResolvedValueOnce({
            id: hub_legacy_uuid(5), workflow_json: '{"phases":[]}', agents_json: '{}',
            readme: 'hello', cliq_version: null, tools: '[]', capability_json: '{}', roles_json: '[]',
        });

        const res = await request(app).post('/v1/teams/get_by_id').send({ name: 'my-team', scope: 'alice' });
        expect(res.status).toBe(200);
        expect(res.body.data.name).toBe('my-team');
    });

    it('returns 404 for non-existent team', async () => {
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        const res = await request(app).post('/v1/teams/get_by_id').send({ name: 'ghost', scope: 'alice' });
        expect(res.status).toBe(404);
    });

    it('returns 404 for private team when unauthenticated', async () => {
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce({
            ...PUBLIC_TEAM, visibility: 'private', author_id: hub_legacy_uuid(99), scope: 'other',
        });
        const res = await request(app).post('/v1/teams/get_by_id').send({ name: 'my-team', scope: 'other' });
        expect(res.status).toBe(404);
    });
});

describe('POST /v1/teams/get_by_id with version', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 200 with specific version', async () => {
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        repos.team_repo.find_author_username.mockResolvedValueOnce('alice');
        repos.version_repo.list_by_team_id.mockResolvedValueOnce([{ version: '1.0.0', changelog: '', published_at: '2025-01-01' }]);
        repos.tag_repo.find_by_team_id.mockResolvedValueOnce([]);
        repos.version_repo.find_detail_by_team_and_version.mockResolvedValueOnce({
            id: hub_legacy_uuid(5), workflow_json: '{"phases":[]}', agents_json: '{}',
            readme: 'hello', cliq_version: null, tools: '[]', capability_json: '{}', roles_json: '[]',
        });
        const res = await request(app).post('/v1/teams/get_by_id').send({ name: 'my-team', scope: 'alice', version: '1.0.0' });
        expect(res.status).toBe(200);
        expect(res.body.data.name).toBe('my-team');
    });

    it('returns 404 for missing version', async () => {
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        repos.team_repo.find_author_username.mockResolvedValueOnce('alice');
        repos.version_repo.list_by_team_id.mockResolvedValueOnce([{ version: '1.0.0', changelog: '', published_at: '2025-01-01' }]);
        repos.tag_repo.find_by_team_id.mockResolvedValueOnce([]);
        const res = await request(app).post('/v1/teams/get_by_id').send({ name: 'my-team', scope: 'alice', version: '9.9.9' });
        expect(res.status).toBe(404);
    });
});

describe('POST /v1/teams/get_versions', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 200 with all versions', async () => {
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        repos.version_repo.list_by_team_id.mockResolvedValueOnce([
            { version: '2.0.0', changelog: 'v2', published_at: '2025-06-01' },
            { version: '1.0.0', changelog: 'v1', published_at: '2025-01-01' },
        ]);
        const res = await request(app).post('/v1/teams/get_versions').send({ name: 'my-team', scope: 'alice' });
        expect(res.body.data.versions).toHaveLength(2);
    });

    it('returns latest only when latest_only is true', async () => {
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        repos.version_repo.find_latest_version.mockResolvedValueOnce('2.1.0');
        const res = await request(app).post('/v1/teams/get_versions').send({ name: 'my-team', scope: 'alice', latest_only: true });
        expect(res.body.data.version).toBe('2.1.0');
    });

    it('returns null version when none published with latest_only', async () => {
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(PUBLIC_TEAM);
        repos.version_repo.find_latest_version.mockResolvedValueOnce(null);
        const res = await request(app).post('/v1/teams/get_versions').send({ name: 'my-team', scope: 'alice', latest_only: true });
        expect(res.body.data.version).toBeNull();
    });

    it('returns 404 for missing team', async () => {
        repos.team_repo.find_by_name_and_scope.mockResolvedValueOnce(null);
        const res = await request(app).post('/v1/teams/get_versions').send({ name: 'ghost' });
        expect(res.status).toBe(404);
    });
});

