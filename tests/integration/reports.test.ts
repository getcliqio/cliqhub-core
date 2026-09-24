import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import express from 'express';
import request from 'supertest';
import { stub_pat_auth, TEST_PAT_PLAINTEXT } from '../helpers/pat_auth.js';
import { make_mock_repos } from '../helpers/test_container.js';
import { create_auth_middleware } from '../../src/middleware/auth_middleware.js';
import { error_handler } from '../../src/middleware/error_handler.js';
import { ReportsService } from '../../src/services/reports_service.js';
import { ReportsController } from '../../src/controllers/reports_controller.js';

vi.mock('../../src/auth/password.js', () => ({
    hash_password: vi.fn().mockResolvedValue('hashed'),
    verify_password: vi.fn().mockResolvedValue(true),
}));

const repos = make_mock_repos();

const audit_repo = {
    create: vi.fn().mockResolvedValue(undefined),
    list_paginated: vi.fn().mockResolvedValue([]),
    count_filtered: vi.fn().mockResolvedValue(0),
};

const app = express();
app.use(express.json());
app.use(create_auth_middleware({
    user_repo: repos.user_repo as any,
    token_repo: repos.token_repo as any,
    scope_repo: repos.scope_repo as any,
    org_member_repo: repos.org_member_repo as any,
}));

const reports_service = new ReportsService(audit_repo as any);
const reports_controller = new ReportsController(reports_service);

app.post('/internal/reports/audit', reports_controller.audit);
app.use(error_handler);

const ADMIN_USER = {
    id: hub_legacy_uuid(1), username: 'admin1', display_name: 'Admin One',
    email: 'admin@test.com', role: 'admin',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

const REGULAR_USER = {
    id: hub_legacy_uuid(2), username: 'bob', display_name: 'Bob',
    email: 'bob@test.com', role: 'user',
    suspended_at: null, suspended_reason: '', created_at: '2025-01-01',
};

function admin_auth_header() {
    return `Bearer ${TEST_PAT_PLAINTEXT}`;
}

function user_auth_header() {
    return `Bearer ${TEST_PAT_PLAINTEXT}`;
}

function mock_admin_auth() {
    stub_pat_auth(repos, ADMIN_USER);
}

function mock_regular_auth() {
    stub_pat_auth(repos, REGULAR_USER);
}

describe('POST /internal/reports/audit', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns paginated audit entries for admin', async () => {
        mock_admin_auth();
        const mock_entries = [
            { id: hub_legacy_uuid(1), admin_id: hub_legacy_uuid(1), action: 'scope.create', target_type: 'scope', target_key: 'acme', details: {}, created_at: '2025-06-01' },
            { id: hub_legacy_uuid(2), admin_id: hub_legacy_uuid(1), action: 'scope.delete', target_type: 'scope', target_key: 'beta', details: {}, created_at: '2025-06-02' },
        ];
        audit_repo.list_paginated.mockResolvedValueOnce(mock_entries);
        audit_repo.count_filtered.mockResolvedValueOnce(2);

        const res = await request(app).post('/internal/reports/audit')
            .set('Authorization', admin_auth_header()).send({});

        expect(res.status).toBe(200);
        expect(res.body.data.entries).toHaveLength(2);
        expect(res.body.data.total).toBe(2);
        expect(res.body.data.limit).toBe(50);
        expect(res.body.data.offset).toBe(0);
    });

    it('filters by action', async () => {
        mock_admin_auth();
        audit_repo.list_paginated.mockResolvedValueOnce([
            { id: hub_legacy_uuid(1), action: 'scope.create' },
        ]);
        audit_repo.count_filtered.mockResolvedValueOnce(1);

        const res = await request(app).post('/internal/reports/audit')
            .set('Authorization', admin_auth_header())
            .send({ action: 'scope.create' });

        expect(res.status).toBe(200);
        expect(res.body.data.entries).toHaveLength(1);
        expect(audit_repo.list_paginated).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'scope.create' }),
            50, 0,
        );
    });

    it('filters by target_type and admin_id', async () => {
        mock_admin_auth();
        audit_repo.list_paginated.mockResolvedValueOnce([]);
        audit_repo.count_filtered.mockResolvedValueOnce(0);

        const res = await request(app).post('/internal/reports/audit')
            .set('Authorization', admin_auth_header())
            .send({ target_type: 'scope', admin_id: hub_legacy_uuid(1) });

        expect(res.status).toBe(200);
        expect(audit_repo.list_paginated).toHaveBeenCalledWith(
            expect.objectContaining({ target_type: 'scope', admin_id: hub_legacy_uuid(1) }),
            50, 0,
        );
    });

    it('respects custom limit and offset', async () => {
        mock_admin_auth();
        audit_repo.list_paginated.mockResolvedValueOnce([]);
        audit_repo.count_filtered.mockResolvedValueOnce(0);

        const res = await request(app).post('/internal/reports/audit')
            .set('Authorization', admin_auth_header())
            .send({ limit: 10, offset: 20 });

        expect(res.status).toBe(200);
        expect(res.body.data.limit).toBe(10);
        expect(res.body.data.offset).toBe(20);
        expect(audit_repo.list_paginated).toHaveBeenCalledWith(
            expect.any(Object), 10, 20,
        );
    });

    it('returns 403 for non-admin user', async () => {
        mock_regular_auth();
        const res = await request(app).post('/internal/reports/audit')
            .set('Authorization', user_auth_header()).send({});
        expect(res.status).toBe(403);
    });

    it('returns 401 when not authenticated', async () => {
        const res = await request(app).post('/internal/reports/audit').send({});
        expect(res.status).toBe(401);
    });
});
