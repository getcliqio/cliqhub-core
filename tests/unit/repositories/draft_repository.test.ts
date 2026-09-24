import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import { Draft } from '../../../src/db/models/index.js';
import { DraftRepository } from '../../../src/repositories/draft_repository.js';

describe('DraftRepository', () => {
    let repo: DraftRepository;

    beforeEach(() => {
        vi.clearAllMocks();
        repo = new DraftRepository();
    });

    it('list_by_user_id returns drafts ordered by updated_at desc', async () => {
        const drafts = [
            { id: hub_legacy_uuid(2), title: 'Draft B', updated_at: '2025-06-02' },
            { id: hub_legacy_uuid(1), title: 'Draft A', updated_at: '2025-06-01' },
        ];
        vi.mocked(Draft.findAll).mockResolvedValueOnce(drafts as any);
        const result = await repo.list_by_user_id(hub_legacy_uuid(1));
        expect(result).toHaveLength(2);
        expect(result[0].id).toBe(hub_legacy_uuid(2));
    });

    it('list_by_user_id returns empty array', async () => {
        vi.mocked(Draft.findAll).mockResolvedValueOnce([]);
        const result = await repo.list_by_user_id(hub_legacy_uuid(999));
        expect(result).toEqual([]);
    });

    it('find_by_id_and_user returns draft when owned', async () => {
        const draft = { id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1), title: 'My Draft', team_json: '{}' };
        vi.mocked(Draft.findOne).mockResolvedValueOnce(draft as any);
        const result = await repo.find_by_id_and_user(hub_legacy_uuid(1), hub_legacy_uuid(1));
        expect(result).toEqual(draft);
    });

    it('find_by_id_and_user returns null for other user', async () => {
        vi.mocked(Draft.findOne).mockResolvedValueOnce(null);
        const result = await repo.find_by_id_and_user(hub_legacy_uuid(1), hub_legacy_uuid(999));
        expect(result).toBeNull();
    });

    it('create returns new draft id', async () => {
        vi.mocked(Draft.create).mockResolvedValueOnce({ id: hub_legacy_uuid(5) } as any);
        const result = await repo.create(hub_legacy_uuid(1), 'New Draft', '{"phases":[]}');
        expect(result).toBe(hub_legacy_uuid(5));
    });

    it('update modifies team_json and title', async () => {
        await repo.update(hub_legacy_uuid(1), '{"phases":[1]}', 'Updated Title');
        expect(Draft.update).toHaveBeenCalledWith(
            expect.objectContaining({ team_json: '{"phases":[1]}', title: 'Updated Title' }),
            expect.objectContaining({ where: { id: hub_legacy_uuid(1) } }),
        );
    });

    it('delete_by_id removes draft', async () => {
        await repo.delete_by_id(hub_legacy_uuid(1));
        expect(Draft.destroy).toHaveBeenCalledWith({ where: { id: hub_legacy_uuid(1) } });
    });
});
