import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import request from 'supertest';
import { create_test_app } from '../helpers/test_container.js';
import { stub_pat_auth } from '../helpers/pat_auth.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hash'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

const { app, repos } = create_test_app();

const ADMIN_USER = {
    id: hub_legacy_uuid(1), username: 'admin', display_name: 'Admin',
    email: 'admin@test.com', role: 'admin',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

function auth_header() {
    return stub_pat_auth(repos, ADMIN_USER);
}

describe('proxy routing', () => {
    beforeEach(() => vi.clearAllMocks());

    it('BFF can reach backend /v1/scopes/get', async () => {
        const res = await request(app)
            .post('/v1/scopes/get')
            .set('Authorization', auth_header())
            .send({ mine: true });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data).toHaveProperty('scopes');
    });

    it('BFF can reach backend /v1/teams/get', async () => {
        repos.team_repo.count_filtered.mockResolvedValueOnce(0);
        repos.team_repo.list_filtered.mockResolvedValueOnce([]);

        const res = await request(app)
            .post('/v1/teams/get')
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data).toHaveProperty('teams');
    });

    it('health endpoint responds on /v1/health', async () => {
        const res = await request(app).get('/v1/health');

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(typeof res.body.timestamp).toBe('number');
    });

    it('404 for non-existent route', async () => {
        const res = await request(app).post('/v1/nonexistent');

        expect(res.status).toBe(404);
    });

    it('error_handler returns JSON for backend errors', async () => {
                repos.team_repo.count_filtered.mockRejectedValueOnce(new Error('db gone'));

        const res = await request(app)
            .post('/v1/teams/get')
            .set('Authorization', auth_header())
            .send({});

        expect(res.status).toBe(500);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toHaveProperty('code');
        expect(res.body.error).toHaveProperty('message');
    });
});
