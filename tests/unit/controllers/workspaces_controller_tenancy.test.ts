/**
 * Core issue #14 — workspaces/get, get_by_id, remove respect realm membership.
 *   site admin → everything; daemon token → its realm's daemons; user → daemons in their realms.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const list = vi.fn();
const get = vi.fn();
const find_by_path = vi.fn();
const remove = vi.fn();
const remove_by_path = vi.fn();
vi.mock('../../../src/services/workspace.service.js', () => ({
    WorkspaceService: { list: (...a: unknown[]) => list(...a), get: (...a: unknown[]) => get(...a), find_by_path: (...a: unknown[]) => find_by_path(...a), remove: (...a: unknown[]) => remove(...a), remove_by_path: (...a: unknown[]) => remove_by_path(...a), list_teams: vi.fn(async () => []) },
}));
const for_user = vi.fn();
const in_realm = vi.fn();
const realm_get = vi.fn();
vi.mock('../../../src/services/realm.service.js', () => ({
    RealmService: { list_daemon_ids_for_user: (...a: unknown[]) => for_user(...a), list_daemon_ids_in_realm: (...a: unknown[]) => in_realm(...a), get: (...a: unknown[]) => realm_get(...a), list_realms_for_daemon: vi.fn(async () => [{ id: 'r1' }]) },
}));
const admin_realms = vi.fn();
vi.mock('../../../src/auth/route_policy/visible.js', () => ({ visible_realm_ids: (...a: unknown[]) => admin_realms(...a) }));

import { WorkspaceController } from '../../../src/controllers/workspaces_controller.js';

type Who = 'admin' | 'user' | 'daemon';
function req(body: Record<string, unknown>, who: Who): Request {
    const user = { id: 'u1', username: 'u', role: who === 'admin' ? 'admin' : 'user' };
    return { body, user: { user_id: 'u1', role: user.role }, auth: { user, org_slugs: [], org_ids: [], scopes: [], ...(who === 'daemon' ? { auth_via: 'daemon_token', realm_id: 'r1' } : { auth_via: 'pat' }) } } as unknown as Request;
}
function res() {
    const r = { json: vi.fn(), status: vi.fn() } as unknown as Response & { json: ReturnType<typeof vi.fn> };
    (r.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(r);
    return r;
}
async function call(fn: (q: Request, s: Response, n: (e?: unknown) => void) => Promise<void>, q: Request) {
    const s = res();
    let err: unknown = null;
    await fn(q, s, (e) => { err = e; });
    return { body: s.json.mock.calls[0]?.[0] as Record<string, unknown> | undefined, err: err as { status_code?: number } | null };
}

beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue({ workspaces: [], total: 0 });
    for_user.mockResolvedValue(['d-mine']);
    in_realm.mockResolvedValue(['d-realm']);
    realm_get.mockResolvedValue({ id: 'r1' });
    admin_realms.mockResolvedValue(['r1']);
});

describe('workspaces/get', () => {
    it('site admin without realm_id: whole hub (no daemon filter)', async () => {
        await call(WorkspaceController.get, req({}, 'admin'));
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ daemon_ids: undefined }));
    });
    it('user without realm_id: only daemons in their realms', async () => {
        await call(WorkspaceController.get, req({}, 'user'));
        expect(for_user).toHaveBeenCalledWith('u1');
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ daemon_ids: ['d-mine'] }));
    });
    it('daemon token without realm_id: its realm only', async () => {
        await call(WorkspaceController.get, req({}, 'daemon'));
        expect(in_realm).toHaveBeenCalledWith('r1');
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ daemon_ids: ['d-realm'] }));
    });
    it('realm_id: user must be a member; non-members are refused', async () => {
        await call(WorkspaceController.get, req({ realm_id: 'r1' }, 'user'));
        expect(realm_get).toHaveBeenCalledWith('r1', 'u1');
        realm_get.mockRejectedValueOnce(Object.assign(new Error('Not a realm member'), { status_code: 403 }));
        const r = await call(WorkspaceController.get, req({ realm_id: 'r2' }, 'user'));
        expect(r.err).toBeTruthy();
        expect(list).toHaveBeenCalledTimes(1);
    });
    it('daemon token may only list its own realm', async () => {
        const r = await call(WorkspaceController.get, req({ realm_id: 'r9' }, 'daemon'));
        expect(r.err?.status_code).toBe(403);
        expect(list).not.toHaveBeenCalled();
    });
});

describe('workspaces/get_by_id + remove', () => {
    it('hides workspaces on daemons the user cannot see (404), shows their own', async () => {
        get.mockResolvedValue({ id: 'w1', daemon_id: 'd-other', teams: [] });
        const hidden = await call(WorkspaceController.get_by_id, req({ id: 'w1' }, 'user'));
        expect(hidden.err?.status_code).toBe(404);
        get.mockResolvedValue({ id: 'w1', daemon_id: 'd-mine', teams: [] });
        const ok = await call(WorkspaceController.get_by_id, req({ id: 'w1' }, 'user'));
        expect(ok.body).toMatchObject({ ok: true });
        get.mockResolvedValue({ id: 'w1', daemon_id: 'd-other', teams: [] });
        const admin = await call(WorkspaceController.get_by_id, req({ id: 'w1' }, 'admin'));
        expect(admin.body).toMatchObject({ ok: true });
    });
    it('remove refuses another tenant’s workspace and never deletes it', async () => {
        find_by_path.mockResolvedValue({ id: 'w2', daemon_id: 'd-other' });
        const r = await call(WorkspaceController.remove, req({ path: '/x' }, 'user'));
        expect(r.err?.status_code).toBe(404);
        expect(remove_by_path).not.toHaveBeenCalled();
        find_by_path.mockResolvedValue({ id: 'w2', daemon_id: 'd-mine' });
        remove_by_path.mockResolvedValue(true);
        const ok = await call(WorkspaceController.remove, req({ path: '/x' }, 'user'));
        expect(ok.body).toEqual({ ok: true, removed: true });
    });
    it('remove needs realm admin on a realm of the daemon', async () => {
        find_by_path.mockResolvedValue({ id: 'w3', daemon_id: 'd-mine' });
        admin_realms.mockResolvedValue([]);
        const r = await call(WorkspaceController.remove, req({ path: '/x' }, 'user'));
        expect(r.err?.status_code).toBe(403);
        expect(remove_by_path).not.toHaveBeenCalled();
    });
    it('remove of an unknown workspace is a no-op', async () => {
        find_by_path.mockResolvedValue(null);
        const r = await call(WorkspaceController.remove, req({ path: '/nope' }, 'user'));
        expect(r.body).toEqual({ ok: true, removed: false });
    });
});
