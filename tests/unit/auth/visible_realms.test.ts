/** visible_realm_ids — the realm visibility rules shared by lists and handlers. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
    OrgMember: { findAll: vi.fn() },
    OrgRole: { findAll: vi.fn() },
    RealmMember: { findAll: vi.fn() },
    Realm: { findAll: vi.fn() },
}));
vi.mock('../../../src/models/index.js', () => m);

import { org_permissions, realm_levels, visible_realm_ids } from '../../../src/auth/route_policy/visible.js';
import { ALL_PERMISSIONS } from '../../../src/auth/permissions.js';

const REALMS = [
    { id: 'A1', org_id: 'acme' }, { id: 'A2', org_id: 'acme' }, { id: 'B1', org_id: 'beta' }, { id: 'P', org_id: null },
];

function setup(opts: {
    members?: Array<{ org_id: string; role: string; role_id: string | null }>;
    roles?: Array<{ id: string; slug: string; is_system: boolean; permissions: string[] }>;
    realm_members?: Array<{ realm_id: string; role: string }>;
    owned?: string[];
}) {
    m.OrgMember.findAll.mockResolvedValue(opts.members ?? []);
    m.OrgRole.findAll.mockResolvedValue(opts.roles ?? []);
    m.RealmMember.findAll.mockResolvedValue(opts.realm_members ?? []);
    const sym = (o: unknown) => (o as Record<symbol, unknown>)[Object.getOwnPropertySymbols(o as object)[0]] as string[];
    m.Realm.findAll.mockImplementation(async (q: { where: Record<string | symbol, unknown> }) => {
        if (q.where.owner_user_id) return (opts.owned ?? []).map((id) => ({ id }));
        const or = sym(q.where) as unknown as Array<{ id?: unknown; org_id?: unknown }>;
        return REALMS
            .filter((r) => or.some((c) => (c.id && sym(c.id).includes(r.id)) || (c.org_id && r.org_id && sym(c.org_id).includes(r.org_id))))
            .filter((r) => !q.where.org_id || r.org_id === q.where.org_id);
    });
}

beforeEach(() => vi.clearAllMocks());

describe('visible_realm_ids', () => {
    it('org owner sees every realm of the org, without memberships', async () => {
        setup({ members: [{ org_id: 'acme', role: 'admin', role_id: 'r-owner' }], roles: [{ id: 'r-owner', slug: 'owner', is_system: true, permissions: [] }] });
        expect((await visible_realm_ids('u')).sort()).toEqual(['A1', 'A2']);
    });

    it('plain member sees only realms they were added to', async () => {
        setup({ members: [{ org_id: 'acme', role: 'member', role_id: 'r-m' }], roles: [{ id: 'r-m', slug: 'member', is_system: false, permissions: ['runs.view'] }], realm_members: [{ realm_id: 'A1', role: 'member' }] });
        expect(await visible_realm_ids('u')).toEqual(['A1']);
    });

    it('need: operate drops realms where the user is only a viewer', async () => {
        setup({ realm_members: [{ realm_id: 'A1', role: 'member' }, { realm_id: 'A2', role: 'operator' }] });
        expect(await visible_realm_ids('u', { need: 'operate' })).toEqual(['A2']);
    });

    it('perm: an org role without it hides the realm; a guest (no org role) keeps it', async () => {
        setup({
            members: [{ org_id: 'acme', role: 'member', role_id: 'r-x' }],
            roles: [{ id: 'r-x', slug: 'no-runs', is_system: false, permissions: ['realms.view'] }],
            realm_members: [{ realm_id: 'A1', role: 'operator' }, { realm_id: 'B1', role: 'operator' }],
        });
        expect(await visible_realm_ids('u', { perm: 'runs.view' })).toEqual(['B1']);
    });

    it('owned realms count as admin; org filter narrows', async () => {
        setup({ owned: ['P'], realm_members: [{ realm_id: 'B1', role: 'member' }] });
        expect((await visible_realm_ids('u')).sort()).toEqual(['B1', 'P']);
        expect(await visible_realm_ids('u', { org_id: 'beta' })).toEqual(['B1']);
    });

    it('no standing anywhere → empty, without a realm query', async () => {
        setup({});
        expect(await visible_realm_ids('u')).toEqual([]);
    });
});

describe('realm_levels and org_permissions (what the app greys out)', () => {
    it('level per visible realm: realm role, org owner/admin = admin, filtered by org', async () => {
        setup({
            members: [{ org_id: 'beta', role: 'admin', role_id: 'r-admin' }],
            roles: [{ id: 'r-admin', slug: 'admin', is_system: false, permissions: ['realms.view'] }],
            realm_members: [{ realm_id: 'A1', role: 'member' }, { realm_id: 'A2', role: 'operator' }],
            owned: ['P'],
        });
        const all = await realm_levels('u');
        expect(Object.fromEntries(all)).toEqual({ A1: 'view', A2: 'operate', B1: 'admin', P: 'admin' });
        expect(Object.fromEntries(await realm_levels('u', { org_id: 'acme' }))).toEqual({ A1: 'view', A2: 'operate' });
    });

    it('org permissions: an owner holds everything; other roles their own list; no membership → absent', async () => {
        setup({
            members: [{ org_id: 'acme', role: 'admin', role_id: 'r-owner' }, { org_id: 'beta', role: 'member', role_id: 'r-op' }],
            roles: [{ id: 'r-owner', slug: 'owner', is_system: true, permissions: [] }, { id: 'r-op', slug: 'operator', is_system: false, permissions: ['teams.run', 'realms.view'] }],
        });
        const perms = await org_permissions('u');
        expect(perms.get('acme')).toEqual([...ALL_PERMISSIONS]);
        expect(perms.get('beta')).toEqual(['teams.run', 'realms.view']);
        expect(perms.has('gamma')).toBe(false);
    });
});
