import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import { ScopeMember, Scope } from '../../../src/db/models/index.js';
import { ScopeMemberRepository } from '../../../src/repositories/scope_member_repository.js';

describe('ScopeMemberRepository', () => {
    let repo: ScopeMemberRepository;

    beforeEach(() => {
        vi.clearAllMocks();
        repo = new ScopeMemberRepository();
    });

    it('find_by_scope_and_user returns match', async () => {
        vi.mocked(ScopeMember.findOne).mockResolvedValueOnce({ scope_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2) } as any);
        const result = await repo.find_by_scope_and_user(hub_legacy_uuid(1), hub_legacy_uuid(2));
        expect(result).toEqual({ scope_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2) });
    });

    it('create inserts scope member', async () => {
        await repo.create(hub_legacy_uuid(1), hub_legacy_uuid(2));
        expect(ScopeMember.create).toHaveBeenCalledWith({ scope_id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(2) });
    });

    it('create_on_conflict_ignore skips duplicate', async () => {
        vi.mocked(ScopeMember.findOrCreate).mockResolvedValueOnce([{} as any, false]);
        await repo.create_on_conflict_ignore(hub_legacy_uuid(1), hub_legacy_uuid(2));
        expect(ScopeMember.findOrCreate).toHaveBeenCalled();
    });

    it('delete_by_scope_and_user removes member', async () => {
        vi.mocked(ScopeMember.destroy).mockResolvedValueOnce(1);
        const result = await repo.delete_by_scope_and_user(hub_legacy_uuid(1), hub_legacy_uuid(2));
        expect(result).toBe(1);
    });

    it('delete_by_scope_id removes all members of scope', async () => {
        await repo.delete_by_scope_id(hub_legacy_uuid(1));
        expect(ScopeMember.destroy).toHaveBeenCalledWith({ where: { scope_id: hub_legacy_uuid(1) } });
    });

    it('delete_by_user_and_org_scopes removes user from all org scopes', async () => {
        vi.mocked(Scope.findAll).mockResolvedValueOnce([{ id: hub_legacy_uuid(10) }, { id: hub_legacy_uuid(20) }] as any);
        await repo.delete_by_user_and_org_scopes(hub_legacy_uuid(2), hub_legacy_uuid(1));
        expect(ScopeMember.destroy).toHaveBeenCalled();
    });

    it('delete_by_user_and_org_scopes does nothing when no org scopes', async () => {
        vi.mocked(Scope.findAll).mockResolvedValueOnce([]);
        await repo.delete_by_user_and_org_scopes(hub_legacy_uuid(2), hub_legacy_uuid(1));
        expect(ScopeMember.destroy).not.toHaveBeenCalled();
    });
});
