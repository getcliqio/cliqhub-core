import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import { Team, User } from '../../../src/db/models/index.js';
import { TeamRepository } from '../../../src/repositories/team_repository.js';

describe('TeamRepository — reads', () => {
    let repo: TeamRepository;

    beforeEach(() => {
        vi.clearAllMocks();
        repo = new TeamRepository();
    });

    it('find_by_name_and_scope returns team with scope', async () => {
        const team = { id: hub_legacy_uuid(1), name: 'my-team', scope: 'alice' };
        vi.mocked(Team.findOne).mockResolvedValueOnce(team as any);
        const result = await repo.find_by_name_and_scope('my-team', 'alice');
        expect(result).toEqual(team);
    });

    it('find_by_name_and_scope with null scope', async () => {
        const team = { id: hub_legacy_uuid(2), name: 'global', scope: null };
        vi.mocked(Team.findOne).mockResolvedValueOnce(team as any);
        const result = await repo.find_by_name_and_scope('global', null);
        expect(result).toEqual(team);
        expect(Team.findOne).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ scope: null }),
        }));
    });

    it('find_by_name_and_scope returns null when not found', async () => {
        vi.mocked(Team.findOne).mockResolvedValueOnce(null);
        const result = await repo.find_by_name_and_scope('ghost', 'alice');
        expect(result).toBeNull();
    });

    it('list_filtered calls Team.findAll with where', async () => {
        vi.mocked(Team.findAll).mockResolvedValueOnce([{ id: hub_legacy_uuid(1), name: 'test', author: { username: 'alice' } }] as any);
        const result = await repo.list_filtered({ listed: 1 }, 50, 0);
        expect(result).toHaveLength(1);
        expect(Team.findAll).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, offset: 0 }));
    });

    it('count_filtered returns total', async () => {
        vi.mocked(Team.count).mockResolvedValueOnce(42);
        const result = await repo.count_filtered({ listed: 1 });
        expect(result).toBe(42);
    });

    it('count_filtered returns 0 when no matches', async () => {
        vi.mocked(Team.count).mockResolvedValueOnce(0);
        const result = await repo.count_filtered({ listed: 0 });
        expect(result).toBe(0);
    });

    it('find_author_username returns username', async () => {
        vi.mocked(User.findByPk).mockResolvedValueOnce({ username: 'alice' } as any);
        const result = await repo.find_author_username(hub_legacy_uuid(1));
        expect(result).toBe('alice');
    });

    it('find_author_username returns null for missing user', async () => {
        vi.mocked(User.findByPk).mockResolvedValueOnce(null);
        const result = await repo.find_author_username(hub_legacy_uuid(999));
        expect(result).toBeNull();
    });

    it('create inserts and returns id', async () => {
        vi.mocked(Team.create).mockResolvedValueOnce({ id: hub_legacy_uuid(10) } as any);
        const result = await repo.create('test', 'alice', 'user', 'desc', hub_legacy_uuid(1), null, 'MIT', 'public');
        expect(result).toBe(hub_legacy_uuid(10));
    });

    it('update calls Team.update', async () => {
        await repo.update(hub_legacy_uuid(1), 'desc', null, 'MIT', 'public');
        expect(Team.update).toHaveBeenCalled();
    });
});
