import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import request from 'supertest';
import { create_test_app } from '../helpers/test_container.js';
import { stub_pat_auth } from '../helpers/pat_auth.js';
import { Team } from '../../src/db/models/index.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hash'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

const { app, repos } = create_test_app();

const ALICE_USER = {
    id: hub_legacy_uuid(1), username: 'alice', display_name: 'alice',
    email: 'alice@test.com', role: 'user',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

function auth_header() {
    return stub_pat_auth(repos, ALICE_USER);
}

describe('Teams draft surface (replaces /v1/drafts/*)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('POST /v1/teams/get with status=draft lists drafts', async () => {
        repos.team_repo.list_by_scope_list.mockResolvedValueOnce([]);
        vi.mocked(Team.findAll).mockResolvedValueOnce([{
            id: hub_legacy_uuid(1), name: 'draft-team', scope: 'alice', description: '',
            install_count: 0, listed: 0, visibility: 'draft', updated_at: '2025-01-01',
        }] as any);
        repos.tag_repo.find_by_team_ids.mockResolvedValueOnce([]);
        const res = await request(app).post('/v1/teams/get')
            .set('Authorization', auth_header())
            .send({ mine: true, status: 'draft' });
        expect(res.status).toBe(200);
        expect(res.body.data.teams).toHaveLength(1);
    });

    it('POST /v1/teams/create requires auth', async () => {
        const res = await request(app).post('/v1/teams/create')
            .send({ name: 'draft-team', scope: 'alice' });
        expect(res.status).toBe(401);
    });

    it('POST /v1/teams/update requires name or team_id', async () => {
        const res = await request(app).post('/v1/teams/update')
            .set('Authorization', auth_header())
            .send({ description: 'x' });
        expect(res.status).toBe(422);
    });

    it('POST /v1/teams/delete requires name or team_id', async () => {
        const res = await request(app).post('/v1/teams/delete')
            .set('Authorization', auth_header())
            .send({});
        // Zod refine on name|team_id → 422
        expect(res.status).toBe(422);
    });
});
