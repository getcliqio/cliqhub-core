import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import { OrgMember, OrgRole } from '../../../src/models/index.js';
import { OrgMemberRepository } from '../../../src/repositories/org_member_repository.js';

describe('OrgMemberRepository', () => {
    let repo: OrgMemberRepository;

    beforeEach(() => {
        vi.clearAllMocks();
        repo = new OrgMemberRepository();
    });

    it('find_by_org_and_user returns role', async () => {
        vi.mocked(OrgMember.findOne).mockResolvedValueOnce({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), role: 'admin' } as any);
        const result = await repo.find_by_org_and_user(hub_legacy_uuid(1), hub_legacy_uuid(2));
        expect(result).toEqual({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), role: 'admin' });
    });

    it('find_by_org_and_user returns null for non-member', async () => {
        vi.mocked(OrgMember.findOne).mockResolvedValueOnce(null);
        const result = await repo.find_by_org_and_user(hub_legacy_uuid(1), hub_legacy_uuid(999));
        expect(result).toBeNull();
    });

    it('list_members_by_org returns all members', async () => {
        const rows = [{ user_id: hub_legacy_uuid(1), role: 'admin', User: { username: 'alice', display_name: 'Alice' } }];
        vi.mocked(OrgMember.findAll).mockResolvedValueOnce(rows as any);
        const result = await repo.list_members_by_org(hub_legacy_uuid(1));
        expect(result).toHaveLength(1);
        expect(result[0].username).toBe('alice');
    });

    it('count_admins_by_org returns admin count', async () => {
        vi.mocked(OrgMember.count).mockResolvedValueOnce(2);
        const result = await repo.count_admins_by_org(hub_legacy_uuid(1));
        expect(result).toBe(2);
    });

    it('create inserts membership with the matching org role id', async () => {
        vi.mocked(OrgRole.findOne).mockResolvedValueOnce({ id: 'role-member' } as any);
        vi.mocked(OrgMember.update).mockResolvedValueOnce([0] as any);
        await repo.create(hub_legacy_uuid(1), hub_legacy_uuid(2), 'member');
        expect(OrgRole.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { org_id: hub_legacy_uuid(1), slug: 'member' } }));
        expect(OrgMember.create).toHaveBeenCalledWith({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), role: 'member', role_id: 'role-member' });
    });

    it('create still inserts when the org has no such role (role_id null)', async () => {
        vi.mocked(OrgRole.findOne).mockResolvedValueOnce(null);
        vi.mocked(OrgMember.update).mockResolvedValueOnce([0] as any);
        await repo.create(hub_legacy_uuid(1), hub_legacy_uuid(2), 'member');
        expect(OrgMember.create).toHaveBeenCalledWith({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), role: 'member', role_id: null });
    });

    it('create revives a former (soft-deleted) membership instead of inserting', async () => {
        vi.mocked(OrgRole.findOne).mockResolvedValueOnce({ id: 'role-member' } as any);
        vi.mocked(OrgMember.update).mockResolvedValueOnce([1] as any);
        await repo.create(hub_legacy_uuid(1), hub_legacy_uuid(2), 'member');
        expect(OrgMember.update).toHaveBeenCalledWith(
            { role: 'member', role_id: 'role-member', status: 'active', deleted_at: null },
            { where: { org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2) } },
        );
        expect(OrgMember.create).not.toHaveBeenCalled();
    });

    it('update_role changes a live member role', async () => {
        await repo.update_role(hub_legacy_uuid(1), hub_legacy_uuid(2), 'admin');
        expect(OrgMember.update).toHaveBeenCalledWith(
            { role: 'admin' },
            { where: { org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), deleted_at: null } },
        );
    });

    it('delete_by_org_and_user soft-deletes the membership', async () => {
        await repo.delete_by_org_and_user(hub_legacy_uuid(1), hub_legacy_uuid(2));
        expect(OrgMember.update).toHaveBeenCalledWith(
            { deleted_at: expect.any(Date) },
            { where: { org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), deleted_at: null } },
        );
        expect(OrgMember.destroy).not.toHaveBeenCalled();
    });

    it('reads see live active memberships only; the member list shows pending and former members', async () => {
        vi.mocked(OrgMember.findOne).mockResolvedValueOnce(null);
        await repo.find_by_org_and_user(hub_legacy_uuid(1), hub_legacy_uuid(2));
        expect(OrgMember.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: { org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), status: 'active', deleted_at: null },
        }));
        const gone = new Date('2026-01-02T00:00:00.000Z');
        vi.mocked(OrgMember.findAll).mockResolvedValueOnce([
            { user_id: hub_legacy_uuid(2), role: 'member', status: 'active', deleted_at: gone, invited_at: null, joined_at: null, User: { username: 'bob' } },
            { user_id: hub_legacy_uuid(3), role: 'member', status: 'pending', deleted_at: null, invited_at: gone, joined_at: null, User: { username: 'cat' } },
        ] as any);
        const members = await repo.list_members_by_org(hub_legacy_uuid(1));
        expect(members.map((m) => [m.status, m.deleted_at])).toEqual([['deleted', gone.toISOString()], ['pending', null]]);
        expect(members[1].invited_at).toBe(gone.toISOString());
    });

    it('list_my_orgs returns orgs for user', async () => {
        const rows = [{ role: 'admin', Org: { id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme', member_count: 3, scope_count: 2 } }];
        vi.mocked(OrgMember.findAll).mockResolvedValueOnce(rows as any);
        const result = await repo.list_my_orgs(hub_legacy_uuid(1));
        expect(result).toHaveLength(1);
        expect(result[0].slug).toBe('acme');
    });
});
