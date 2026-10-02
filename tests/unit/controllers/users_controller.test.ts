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
        new_user: vi.fn().mockResolvedValue({
            user: { id: hub_legacy_uuid(1), username: 'test', email: 'test@example.com', status: 'invited' },
            setup: { expires_at: '2026-10-09T00:00:00.000Z', email_sent: true, setup_url: null },
        }),
        update: vi.fn().mockResolvedValue({ updated: true }),
        delete: vi.fn().mockResolvedValue({ deleted: true }),
        suspend: vi.fn().mockResolvedValue({ suspended: true }),
        unsuspend: vi.fn().mockResolvedValue({ suspended: false }),
        reset_password: vi.fn().mockResolvedValue({ reset_id: hub_legacy_uuid(9), expires_at: '2026-10-03T00:00:00.000Z', email_sent: true, reset_url: null }),
        forgot_password: vi.fn().mockResolvedValue({ requested: true }),
        set_role: vi.fn().mockResolvedValue({ role: 'admin' }),
        update_role: vi.fn().mockResolvedValue({
            user_id: hub_legacy_uuid(2), org_id: hub_legacy_uuid(1), role_id: hub_legacy_uuid(3), role_slug: 'admin', role: 'admin',
        }),
        change_password: vi.fn().mockResolvedValue({ user: { id: hub_legacy_uuid(1), username: 'test', status: 'active' }, sessions_revoked: 1 }),
        change_password_with_token: vi.fn().mockResolvedValue({ user: { id: hub_legacy_uuid(1), username: 'test', status: 'active' }, sessions_revoked: 2 }),
    };
}

function make_app(service = make_users_service()) {
    const controller = new UsersController(service as any);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.auth = { user: { id: hub_legacy_uuid(1), role: 'admin' }, org_slugs: [], org_ids: [], scopes: [] } as any;
        next();
    });
    app.post('/v1/users/get', controller.wrap(controller.get));
    app.post('/v1/users/get_by_id', controller.wrap(controller.get_by_id));
    app.post('/internal/users/new', controller.wrap(controller.new_user));
    app.post('/v1/users/update', controller.wrap(controller.update));
    app.post('/v1/users/delete', controller.wrap(controller.delete_user));
    app.post('/v1/users/suspend', controller.wrap(controller.suspend));
    app.post('/v1/users/unsuspend', controller.wrap(controller.unsuspend));
    app.post('/internal/users/reset_password', controller.wrap(controller.reset_password));
    app.post('/internal/users/set_role', controller.wrap(controller.set_role));
    app.post('/internal/users/update_role', controller.wrap(controller.update_role));
    app.post('/internal/users/change_password', controller.wrap(controller.change_password));
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

    it('POST /internal/users/new accepts valid input', async () => {
        const res = await request(app).post('/internal/users/new').send({
            username: 'alice',
            email: 'alice@example.com',
            reactivate: true,
        });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            user: { id: hub_legacy_uuid(1), username: 'test', email: 'test@example.com', status: 'invited' },
            setup: { expires_at: '2026-10-09T00:00:00.000Z', email_sent: true, setup_url: null },
        });
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

    describe('reset_password and change_password pick the caller by the body', () => {
        it('{ user_id } → the site-admin reset', async () => {
            const service = make_users_service();
            const res = await request(make_app(service)).post('/internal/users/reset_password').send({ user_id: hub_legacy_uuid(5) });
            expect(res.status).toBe(200);
            expect(service.reset_password).toHaveBeenCalledWith(expect.anything(), { user_id: hub_legacy_uuid(5) });
            expect(service.forgot_password).not.toHaveBeenCalled();
        });

        it('{ email } → forgot password with the normalized email only (no client address is read)', async () => {
            const service = make_users_service();
            const res = await request(make_app(service)).post('/internal/users/reset_password')
                .set('X-Forwarded-For', '198.51.100.7').send({ email: '  Priya@Example.com ' });
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ requested: true });
            expect(service.forgot_password).toHaveBeenCalledWith({ email: 'priya@example.com' });
            expect(service.reset_password).not.toHaveBeenCalled();
        });

        it('{ email, user_id } → 422 (one caller per request)', async () => {
            const res = await request(app).post('/internal/users/reset_password').send({ email: 'a@example.com', user_id: hub_legacy_uuid(5) });
            expect(res.status).toBe(422);
        });

        it('{ user_id, new_password } → 422 (a site admin cannot set a password)', async () => {
            const res = await request(app).post('/internal/users/reset_password').send({ user_id: hub_legacy_uuid(5), new_password: 'longenough1' });
            expect(res.status).toBe(422);
        });

        it('{ reset_token, new_password } → the token change', async () => {
            const service = make_users_service();
            const res = await request(make_app(service)).post('/internal/users/change_password').send({ reset_token: 'tok', new_password: 'longenough1' });
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ user: { id: hub_legacy_uuid(1), username: 'test', status: 'active' }, sessions_revoked: 2 });
            expect(service.change_password_with_token).toHaveBeenCalledWith({ reset_token: 'tok', new_password: 'longenough1' });
            expect(service.change_password).not.toHaveBeenCalled();
        });

        it('{ current_password, new_password } → the signed-in change', async () => {
            const service = make_users_service();
            const res = await request(make_app(service)).post('/internal/users/change_password').send({ current_password: 'old', new_password: 'longenough1' });
            expect(res.status).toBe(200);
            expect(res.body.data.sessions_revoked).toBe(1);
            expect(service.change_password_with_token).not.toHaveBeenCalled();
        });
    });

});
