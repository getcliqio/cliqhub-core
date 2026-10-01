/**
 * Step 0 hotfix — S1 (settings writes), S2 (settings reads), S18 (admin-minted
 * daemon token is not a site admin), S21 (system/seed), S22 (bootstrap admin).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

const settings = vi.hoisted(() => ({
    get: vi.fn().mockResolvedValue({ key: 'k', value: 'v' }),
    set: vi.fn().mockResolvedValue(true),
    list: vi.fn().mockResolvedValue([]),
    list_by_prefix: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(true),
}));
const realm = vi.hoisted(() => ({
    assert_daemon_in_realm: vi.fn(),
}));
const seed = vi.hoisted(() => ({ seed_all: vi.fn().mockResolvedValue(undefined) }));
const models = vi.hoisted(() => ({
    User: { findOne: vi.fn(), create: vi.fn() },
}));

vi.mock('../../../src/services/hub_settings_service.js', () => ({ SettingsService: settings }));
vi.mock('../../../src/services/realm.service.js', () => ({ RealmService: realm }));
vi.mock('../../../src/models/index.js', async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    User: models.User,
}));
vi.mock('../../../src/repositories/realm_repository.js', () => ({
    RealmRepository: class { find_by_id = vi.fn().mockResolvedValue({ id: 'realm-a', org_id: 'org-a' }); },
}));
vi.mock('../../../src/auth/password.js', () => ({ hash_password: vi.fn().mockResolvedValue('hashed') }));

import { SettingsController } from '../../../src/controllers/hub_settings_controller.js';
import { SystemController } from '../../../src/controllers/system_controller.js';
import { AdminCheck } from '../../../src/lib/site_admin.js';
import { BaseController } from '../../../src/controllers/base_controller.js';
import { ensure_bootstrap_admin } from '../../../src/lib/seed.js';
import { policy_status, type TestCaller } from '../../helpers/policy_decision.js';

type Caller = 'anon' | 'user' | 'admin' | 'admin_daemon' | 'user_daemon';

function auth_for(who: Caller): Request['auth'] {
    const base = { org_slugs: [], org_ids: ['org-a'], scopes: [] };
    switch (who) {
        case 'anon': return undefined;
        case 'user': return { ...base, user: { id: 'u1', role: 'user' }, auth_via: 'pat' } as never;
        case 'admin': return { ...base, user: { id: 'a1', role: 'admin' }, auth_via: 'pat' } as never;
        case 'admin_daemon': return { ...base, user: { id: 'a1', role: 'admin' }, auth_via: 'daemon_token', realm_id: 'realm-a' } as never;
        case 'user_daemon': return { ...base, user: { id: 'u1', role: 'user' }, auth_via: 'daemon_token', realm_id: 'realm-a' } as never;
    }
}

async function call(
    handler: (req: Request, res: Response, next: (e?: unknown) => void) => Promise<void>,
    who: Caller,
    body: Record<string, unknown> = {},
): Promise<{ status: number; body?: unknown }> {
    const req = { auth: auth_for(who), body, request_id: 'rid' } as unknown as Request;
    let out: { status: number; body?: unknown } = { status: 0 };
    const res = {
        json: (b: unknown) => { out = { status: 200, body: b }; return res; },
        status: () => res,
    } as unknown as Response;
    await handler(req, res, (err?: unknown) => {
        out = { status: (err as { status_code?: number })?.status_code ?? 500 };
    });
    return out;
}

const TEST_CALLER: Record<Caller, TestCaller | null> = {
    anon: null,
    user: { id: 'u1' },
    admin: { id: 'a1', role: 'admin' },
    admin_daemon: { id: 'a1', role: 'admin', daemon: { realm_id: 'realm-a' } },
    user_daemon: { id: 'u1', daemon: { realm_id: 'realm-a' } },
};

/** The route policy first (as in production), then the handler if it lets the request through. */
async function call_route(
    route: string,
    handler: Parameters<typeof call>[0],
    who: Caller,
    body: Record<string, unknown> = {},
): Promise<{ status: number; body?: unknown }> {
    const status = await policy_status(route, TEST_CALLER[who], body);
    return status === 200 ? call(handler, who, body) : { status };
}

beforeEach(() => {
    vi.clearAllMocks();
    realm.assert_daemon_in_realm.mockImplementation(async (realm_id: string, daemon_id: string) => {
        if (realm_id === 'realm-a' && daemon_id === 'd-own') return;
        throw Object.assign(new Error('nope'), { status_code: 403 });
    });
});

describe('S1 settings/set and settings/remove are site-admin only', () => {
    it.each([
        ['anon', 401], ['user', 403], ['user_daemon', 403], ['admin_daemon', 403], ['admin', 200],
    ] as const)('set as %s → %i', async (who, status) => {
        const r = await call_route('POST /v1/settings/set', SettingsController.set, who, { key: 'docker.base_image', value: 'evil' });
        expect(r.status).toBe(status);
        expect(settings.set).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    });

    it.each([
        ['anon', 401], ['user', 403], ['admin_daemon', 403], ['admin', 200],
    ] as const)('remove as %s → %i', async (who, status) => {
        const r = await call_route('POST /v1/settings/remove', SettingsController.remove, who, { key: 'hub.registry_url' });
        expect(r.status).toBe(status);
        expect(settings.remove).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    });
});

describe('S2 settings/get and get_by_key', () => {
    it.each([
        ['anon', {}, 401],
        ['user', {}, 403],
        ['user', { daemon_id: 'd-own' }, 403],
        ['admin', { daemon_id: 'd-other' }, 200],
        ['user_daemon', {}, 200],
        ['user_daemon', { daemon_id: 'd-own' }, 200],
        ['user_daemon', { daemon_id: 'd-other' }, 403],
        ['admin_daemon', { daemon_id: 'd-other' }, 403],
    ] as const)('get as %s %o → %i', async (who, body, status) => {
        const r = await call_route('POST /v1/settings/get', SettingsController.get, who, body);
        expect(r.status).toBe(status);
        expect(settings.list).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    });

    it.each([
        ['anon', 401], ['user', 403], ['user_daemon', 200], ['admin', 200],
    ] as const)('get_by_key as %s → %i', async (who, status) => {
        const r = await call_route('POST /v1/settings/get_by_key', SettingsController.get_by_key, who, { key: 'docker.base_image' });
        expect(r.status).toBe(status);
    });
});

describe('S21 system/seed is site-admin only', () => {
    vi.mock('../../../src/lib/seed.js', async (orig) => ({
        ...(await orig<typeof import('../../../src/lib/seed.js')>()),
        seed_all: seed.seed_all,
    }));
    it.each([
        ['anon', 401], ['user', 403], ['admin_daemon', 403], ['admin', 200],
    ] as const)('seed as %s → %i', async (who, status) => {
        const r = await call_route('POST /v1/system/seed', SystemController.seed, who);
        expect(r.status).toBe(status);
        expect(seed.seed_all).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    });
});

describe('S18 admin-minted daemon token is not a site admin', () => {
    it('AdminCheck.is_site_admin is false for a daemon token', () => {
        expect(AdminCheck.is_site_admin({ auth: auth_for('admin_daemon') } as Request)).toBe(false);
        expect(AdminCheck.is_site_admin({ auth: auth_for('admin') } as Request)).toBe(true);
    });

    class Probe extends BaseController {
        check(auth: Request['auth'], org_id: string) { return this.assert_org_authorized(auth as never, org_id); }
    }

    it('assert_org_authorized: admin user may act on any org', async () => {
        await expect(new Probe().check(auth_for('admin'), 'org-z')).resolves.toBeUndefined();
    });

    it('assert_org_authorized: admin-minted daemon token is held to its realm org', async () => {
        await expect(new Probe().check(auth_for('admin_daemon'), 'org-z')).rejects.toMatchObject({ status_code: 403 });
    });

    it('assert_org_authorized: admin-minted daemon token still works in its own org', async () => {
        await expect(new Probe().check(auth_for('admin_daemon'), 'org-a')).resolves.toBeUndefined();
    });
});

describe('S22 bootstrap admin comes from the environment', () => {
    const saved = { ...process.env };
    afterEach(() => { process.env = { ...saved }; });

    it('uses the first existing user and creates nothing', async () => {
        models.User.findOne.mockResolvedValue({ id: 'existing' });
        await expect(ensure_bootstrap_admin()).resolves.toBe('existing');
        expect(models.User.create).not.toHaveBeenCalled();
    });

    it('empty DB, no env, development → skips (no default password)', async () => {
        models.User.findOne.mockResolvedValue(null);
        delete process.env.CLIQ_BOOTSTRAP_ADMIN_USER;
        delete process.env.CLIQ_BOOTSTRAP_ADMIN_PASSWORD;
        process.env.NODE_ENV = 'development';
        await expect(ensure_bootstrap_admin()).resolves.toBeNull();
        expect(models.User.create).not.toHaveBeenCalled();
    });

    it('empty DB, no env, production → refuses to start', async () => {
        models.User.findOne.mockResolvedValue(null);
        delete process.env.CLIQ_BOOTSTRAP_ADMIN_USER;
        delete process.env.CLIQ_BOOTSTRAP_ADMIN_PASSWORD;
        process.env.NODE_ENV = 'production';
        await expect(ensure_bootstrap_admin()).rejects.toThrow(/bootstrap admin/);
        expect(models.User.create).not.toHaveBeenCalled();
    });

    it('rejects a short password', async () => {
        models.User.findOne.mockResolvedValue(null);
        process.env.CLIQ_BOOTSTRAP_ADMIN_USER = 'root';
        process.env.CLIQ_BOOTSTRAP_ADMIN_PASSWORD = 'short';
        await expect(ensure_bootstrap_admin()).rejects.toThrow(/at least/);
    });

    it('creates the admin from env', async () => {
        models.User.findOne.mockResolvedValue(null);
        models.User.create.mockResolvedValue({ id: 'new-admin' });
        process.env.CLIQ_BOOTSTRAP_ADMIN_USER = 'root';
        process.env.CLIQ_BOOTSTRAP_ADMIN_PASSWORD = 'a-long-password';
        await expect(ensure_bootstrap_admin()).resolves.toBe('new-admin');
        expect(models.User.create).toHaveBeenCalledWith(expect.objectContaining({
            username: 'root', role: 'admin', password_hash: 'hashed',
        }));
    });
});
