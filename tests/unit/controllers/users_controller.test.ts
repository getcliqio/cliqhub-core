import { describe, it, expect, vi } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import express from 'express';
import request from 'supertest';
import { UsersController } from '../../../src/controllers/users_controller.js';
import { error_handler } from '../../../src/middleware/error_handler.js';

function make_users_service() {
    return {
        get: vi.fn().mockResolvedValue({ users: [], total: 0, limit: 50, offset: 0 }),
        get_by_id: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1), username: 'test' }),
        new_user: vi.fn().mockResolvedValue({ id: hub_legacy_uuid(1), username: 'test' }),
        update: vi.fn().mockResolvedValue({ updated: true }),
        delete: vi.fn().mockResolvedValue({ deleted: true }),
        suspend: vi.fn().mockResolvedValue({ suspended: true }),
        unsuspend: vi.fn().mockResolvedValue({ suspended: false }),
        reset_password: vi.fn().mockResolvedValue({ reset: true }),
        set_role: vi.fn().mockResolvedValue({ role: 'admin' }),
        update_role: vi.fn().mockResolvedValue({
            user_id: hub_legacy_uuid(2), org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(3), role_slug: 'admin', role: 'admin',
        }),
        change_password: vi.fn().mockResolvedValue({ message: 'Password changed' }),
    };
}

function make_app() {
    const service = make_users_service();
    const controller = new UsersController(service as any);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.auth = { user: { id: hub_legacy_uuid(1), role: 'admin' }, org_slugs: [], org_ids: [], scopes: [] } as any;
        next();
    });
    app.post('/v1/users/get', controller.get);
    app.post('/v1/users/get_by_id', controller.get_by_id);
    app.post('/internal/users/new', controller.new_user);
    app.post('/v1/users/update', controller.update);
    app.post('/v1/users/delete', controller.delete_user);
    app.post('/v1/users/suspend', controller.suspend);
    app.post('/v1/users/unsuspend', controller.unsuspend);
    app.post('/internal/users/reset_password', controller.reset_password);
    app.post('/internal/users/set_role', controller.set_role);
    app.post('/internal/users/update_role', controller.update_role);
    app.post('/internal/users/change_password', controller.change_password);
    app.use(error_handler);
    return app;
}

describe('UsersController', () => {
    const app = make_app();

    it('GET /v1/users/get accepts empty body', async () => {
        const res = await request(app).post('/v1/users/get').send({});
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    it('GET /v1/users/get_by_id rejects missing user_id', async () => {
        const res = await request(app).post('/v1/users/get_by_id').send({});
        expect(res.status).toBe(422);
        expect(res.body.ok).toBe(false);
        expect(res.body.error.code).toBe('invalid_params');
    });

    it('GET /v1/users/get_by_id accepts valid user_id', async () => {
        const res = await request(app).post('/v1/users/get_by_id').send({ user_id: hub_legacy_uuid(1) });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    it('POST /internal/users/new rejects missing username', async () => {
        const res = await request(app).post('/internal/users/new').send({
            email: 'a@b.com',
            password: 'longpassword',
        });
        expect(res.status).toBe(422);
        expect(res.body.error.message).toContain('username');
    });

    it('POST /internal/users/new rejects missing email', async () => {
        const res = await request(app).post('/internal/users/new').send({
            username: 'alice',
            password: 'longpassword',
        });
        expect(res.status).toBe(422);
        expect(res.body.error.message).toContain('email');
    });

    it('POST /internal/users/new rejects short password', async () => {
        const res = await request(app).post('/internal/users/new').send({
            username: 'alice',
            email: 'a@b.com',
            password: 'short',
        });
        expect(res.status).toBe(422);
        expect(res.body.error.message).toContain('password');
    });

    it('POST /internal/users/new accepts valid input', async () => {
        const res = await request(app).post('/internal/users/new').send({
            username: 'alice',
            email: 'alice@example.com',
            password: 'securepass',
        });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    it('POST /v1/users/update rejects empty body (no display_name or email)', async () => {
        const res = await request(app).post('/v1/users/update').send({});
        expect(res.status).toBe(422);
        expect(res.body.ok).toBe(false);
    });

    it('POST /v1/users/delete rejects missing user_id', async () => {
        const res = await request(app).post('/v1/users/delete').send({});
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('invalid_params');
    });

    it('POST /v1/users/suspend rejects missing user_id', async () => {
        const res = await request(app).post('/v1/users/suspend').send({});
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('invalid_params');
    });

    it('POST /internal/users/set_role rejects invalid role', async () => {
        const res = await request(app).post('/internal/users/set_role').send({
            user_id: hub_legacy_uuid(1),
            role: 'superadmin',
        });
        expect(res.status).toBe(422);
        expect(res.body.error.message).toContain('role');
    });

    it('POST /internal/users/update_role accepts valid input', async () => {
        const res = await request(app).post('/internal/users/update_role').send({
            user_id: hub_legacy_uuid(2),
            org_id: hub_legacy_uuid(1),
            role_id: hub_legacy_uuid(3),
        });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.role_id).toBe(hub_legacy_uuid(3));
    });

    it('POST /internal/users/update_role rejects missing role_id', async () => {
        const res = await request(app).post('/internal/users/update_role').send({
            user_id: hub_legacy_uuid(2),
            org_id: hub_legacy_uuid(1),
        });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('invalid_params');
    });

    it('POST /internal/users/change_password rejects missing current_password', async () => {
        const res = await request(app).post('/internal/users/change_password').send({
            new_password: 'newpass123',
        });
        expect(res.status).toBe(422);
        expect(res.body.error.message).toContain('current_password');
    });

});
