import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import { OrgMember } from '../../../src/db/models/index.js';
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

    it('create inserts membership', async () => {
        await repo.create(hub_legacy_uuid(1), hub_legacy_uuid(2), 'member');
        expect(OrgMember.create).toHaveBeenCalledWith({ org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2), role: 'member' });
    });

    it('update_role changes member role', async () => {
        await repo.update_role(hub_legacy_uuid(1), hub_legacy_uuid(2), 'admin');
        expect(OrgMember.update).toHaveBeenCalledWith(
            { role: 'admin' },
            { where: { org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2) } },
        );
    });

    it('delete_by_org_and_user removes membership', async () => {
        await repo.delete_by_org_and_user(hub_legacy_uuid(1), hub_legacy_uuid(2));
        expect(OrgMember.destroy).toHaveBeenCalledWith({ where: { org_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2) } });
    });

    it('list_my_orgs returns orgs for user', async () => {
        const rows = [{ role: 'admin', Org: { id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme', member_count: 3, scope_count: 2 } }];
        vi.mocked(OrgMember.findAll).mockResolvedValueOnce(rows as any);
        const result = await repo.list_my_orgs(hub_legacy_uuid(1));
        expect(result).toHaveLength(1);
        expect(result[0].slug).toBe('acme');
    });
});
