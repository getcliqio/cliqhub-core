import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { DraftsService } from '../../../src/services/drafts_service.js';
import { ALICE, BOB, UNAUTHED } from '../../helpers/fixtures.js';

function make_draft_repo() {
    return {
        list_by_user_id: vi.fn().mockResolvedValue([]),
        find_by_id_and_user: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(hub_legacy_uuid(1)),
        update: vi.fn(),
        delete_by_id: vi.fn(),
        count_by_user_id: vi.fn().mockResolvedValue(0),
        count_total: vi.fn().mockResolvedValue(0),
    };
}

const DRAFT = {
    id: hub_legacy_uuid(1), user_id: hub_legacy_uuid(1), title: 'My Team',
    team_json: '{"phases":[]}', created_at: '2025-01-01', updated_at: '2025-06-01',
};

describe('DraftsService', () => {
    let service: DraftsService;
    let draft_repo: ReturnType<typeof make_draft_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        draft_repo = make_draft_repo();
        service = new DraftsService(draft_repo as any);
    });

    describe('get', () => {
        it('returns user drafts', async () => {
            draft_repo.list_by_user_id.mockResolvedValueOnce([
                { id: hub_legacy_uuid(1), title: 'Draft A', updated_at: '2025-06-01' },
            ]);
            const result = await service.get(ALICE);
            expect(result.drafts).toHaveLength(1);
        });

        it('returns empty for user with no drafts', async () => {
            const result = await service.get(ALICE);
            expect(result.drafts).toEqual([]);
        });

        it('throws 401 when unauthenticated', async () => {
            await expect(service.get(UNAUTHED)).rejects.toThrow('Authentication required');
        });
    });

    describe('get_by_id', () => {
        it('returns draft for owner', async () => {
            draft_repo.find_by_id_and_user.mockResolvedValueOnce(DRAFT);
            const result = await service.get_by_id(ALICE, { id: hub_legacy_uuid(1) });
            expect(result.title).toBe('My Team');
        });

        it('throws not_found for missing draft', async () => {
            await expect(service.get_by_id(ALICE, { id: hub_legacy_uuid(999) })).rejects.toThrow('Draft not found');
        });

        it('throws not_found for wrong user', async () => {
            draft_repo.find_by_id_and_user.mockResolvedValueOnce(null);
            await expect(service.get_by_id(BOB, { id: hub_legacy_uuid(1) })).rejects.toThrow('Draft not found');
        });

        it('throws 401 when unauthenticated', async () => {
            await expect(service.get_by_id(UNAUTHED, { id: hub_legacy_uuid(1) })).rejects.toThrow('Authentication required');
        });
    });

    describe('new_draft', () => {
        it('creates new draft with default title', async () => {
            const result = await service.new_draft(ALICE, { team_json: '{}' });
            expect(result.id).toBe(hub_legacy_uuid(1));
            expect(draft_repo.create).toHaveBeenCalledWith(hub_legacy_uuid(1), 'Untitled Team', '{}');
        });

        it('uses provided title', async () => {
            await service.new_draft(ALICE, { title: 'Custom', team_json: '{}' });
            expect(draft_repo.create).toHaveBeenCalledWith(hub_legacy_uuid(1), 'Custom', '{}');
        });

        it('throws 401 when unauthenticated', async () => {
            await expect(service.new_draft(UNAUTHED, { team_json: '{}' }))
                .rejects.toThrow('Authentication required');
        });
    });

    describe('update', () => {
        it('updates existing draft', async () => {
            draft_repo.find_by_id_and_user.mockResolvedValueOnce(DRAFT);
            const result = await service.update(ALICE, { id: hub_legacy_uuid(1), title: 'Updated', team_json: '{"new":true}' });
            expect(result.id).toBe(hub_legacy_uuid(1));
            expect(draft_repo.update).toHaveBeenCalledWith(hub_legacy_uuid(1), '{"new":true}', 'Updated');
        });

        it('throws not_found when updating non-existent draft', async () => {
            await expect(service.update(ALICE, { id: hub_legacy_uuid(999), team_json: '{}' }))
                .rejects.toThrow('Draft not found');
        });

        it('throws not_found when updating other user draft', async () => {
            draft_repo.find_by_id_and_user.mockResolvedValueOnce(null);
            await expect(service.update(BOB, { id: hub_legacy_uuid(1), team_json: '{}' }))
                .rejects.toThrow('Draft not found');
        });

        it('throws 401 when unauthenticated', async () => {
            await expect(service.update(UNAUTHED, { id: hub_legacy_uuid(1), team_json: '{}' }))
                .rejects.toThrow('Authentication required');
        });
    });

    describe('delete_draft', () => {
        it('deletes owned draft', async () => {
            draft_repo.find_by_id_and_user.mockResolvedValueOnce(DRAFT);
            const result = await service.delete_draft(ALICE, { id: hub_legacy_uuid(1) });
            expect(result.deleted).toBe(true);
            expect(draft_repo.delete_by_id).toHaveBeenCalledWith(hub_legacy_uuid(1));
        });

        it('throws not_found for missing draft', async () => {
            await expect(service.delete_draft(ALICE, { id: hub_legacy_uuid(999) }))
                .rejects.toThrow('Draft not found');
        });

        it('throws not_found for wrong user', async () => {
            draft_repo.find_by_id_and_user.mockResolvedValueOnce(null);
            await expect(service.delete_draft(BOB, { id: hub_legacy_uuid(1) }))
                .rejects.toThrow('Draft not found');
        });

        it('throws 401 when unauthenticated', async () => {
            await expect(service.delete_draft(UNAUTHED, { id: hub_legacy_uuid(1) }))
                .rejects.toThrow('Authentication required');
        });
    });
});
