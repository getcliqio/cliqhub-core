/**
 * realms/create with everything at once (real Postgres): the realm (with a description and
 * hello-world on its team list), people already in the org, email invites and an enrollment token
 * are saved together — or, when any part fails, none of it is.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { ApiToken, Org, OrgMember, Realm, RealmMember, User } from '../../src/models/index.js';
import { RealmService } from '../../src/services/realm.service.js';
import { InvitationsService } from '../../src/services/invitations_service.js';
import { use_test_link_env } from '../helpers/link_env.js';

const has_postgres = await postgres_reachable();
const uid = () => `rca-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!has_postgres)('realms/create: all or nothing', () => {
    const owner = hub_legacy_uuid(1);
    const teammate = randomUUID();
    const outsider = randomUUID();
    let org_id = '';
    const auth = { user: { id: owner, role: 'user', username: 'owner', email: 'owner@cliq.test' }, org_ids: [], org_slugs: [], scopes: [] } as any;

    let restore_env: () => void = () => {};
    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        // Invite links are encrypted at rest (TOKEN_ENCRYPTION_KEY) and point at the web app.
        restore_env = use_test_link_env();
        await open_test_control_plane_store();
        const org = await Org.create({ slug: uid().slice(0, 30), display_name: 'Atomic', activated_at: new Date() } as any);
        org_id = org.get('id') as string;
        for (const [id, name] of [[teammate, 'tm'], [outsider, 'out']] as const) {
            await User.create({ id, username: `${name}-${uid()}`.slice(0, 30), email: `${name}-${uid()}@cliq.test`, status: 'active', role: 'user', password_hash: 'x' } as any);
        }
        await OrgMember.create({ org_id, user_id: owner, role: 'owner', status: 'active' } as any).catch(() => {});
        await OrgMember.create({ org_id, user_id: teammate, role: 'member', status: 'active' } as any);
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => { await close_test_control_plane_store(); restore_env(); });

    it('saves the realm, description, hello-world, people, invites and token together', async () => {
        const slug = uid().slice(0, 30);
        const email = `new-${uid()}@cliq.test`;
        const realm = await RealmService.create(owner, slug, 'Atomic one', {
            org_id, description: '  Production delivery  ', auth,
            members: [{ user_id: teammate, role: 'operator' }],
            invites: [{ email, role: 'member' }],
            enroll_token: { name: `${slug}-enroll` },
        });
        expect(realm.description).toBe('Production delivery');
        expect(realm.members_added).toEqual([{ user_id: teammate, role: 'operator' }]);
        expect(realm.invites).toEqual([expect.objectContaining({ email, role: 'member' })]);
        expect(realm.enroll_token?.token).toMatch(/\S{20,}/);
        const row = (await Realm.findByPk(realm.id, { raw: true })) as any;
        expect(row.team_list).toEqual([{ scope: 'cliq', slug: 'hello-world' }]);
        const members = await RealmMember.unscoped().findAll({ where: { realm_id: realm.id, member_type: 'user' }, raw: true }) as any[];
        expect(members.map((m) => [m.member_id === owner ? 'owner' : m.member_id === teammate ? 'teammate' : 'invitee', m.role, m.status]).sort())
            .toEqual([['invitee', 'member', 'pending'], ['owner', 'admin', 'active'], ['teammate', 'operator', 'active']].sort());
        expect(await ApiToken.count({ where: { name: `${slug}-enroll` } })).toBe(1);
    });

    it('someone not in the org is refused before anything is written', async () => {
        const slug = uid().slice(0, 30);
        await expect(RealmService.create(owner, slug, 'Nope', { org_id, auth, members: [{ user_id: outsider, role: 'operator' }] }))
            .rejects.toMatchObject({ status_code: 422, code: 'invalid_params' });
        expect(await Realm.count({ where: { slug, org_id } })).toBe(0);
    });

    it('a failure partway (an invite) rolls everything back: no realm, no members, no token', async () => {
        const slug = uid().slice(0, 30);
        vi.spyOn(InvitationsService.prototype, 'send_in_transaction').mockRejectedValueOnce(new Error('mail table down'));
        await expect(RealmService.create(owner, slug, 'Half', {
            org_id, auth,
            members: [{ user_id: teammate, role: 'operator' }],
            invites: [{ email: `x-${uid()}@cliq.test`, role: 'member' }],
            enroll_token: { name: `${slug}-enroll` },
        })).rejects.toThrow('mail table down');
        expect(await Realm.count({ where: { slug, org_id } })).toBe(0);
        expect(await ApiToken.count({ where: { name: `${slug}-enroll` } })).toBe(0);
    });

    it('a plain create (CLI) still works: name and slug only, hello-world included', async () => {
        const slug = uid().slice(0, 30);
        const realm = await RealmService.create(owner, slug, 'Plain', { org_id });
        expect(realm.description).toBeNull();
        expect(realm.enroll_token).toBeNull();
        expect(((await Realm.findByPk(realm.id, { raw: true })) as any).team_list).toEqual([{ scope: 'cliq', slug: 'hello-world' }]);
    });
});
