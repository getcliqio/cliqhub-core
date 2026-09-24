import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import { TeamVersion } from '../../../src/db/models/index.js';
import { TeamVersionRepository } from '../../../src/repositories/team_version_repository.js';

describe('TeamVersionRepository', () => {
    let repo: TeamVersionRepository;

    beforeEach(() => {
        vi.clearAllMocks();
        repo = new TeamVersionRepository();
    });

    it('find_by_team_and_version returns version when found', async () => {
        const ver = { id: hub_legacy_uuid(10), version: '1.0.0' };
        vi.mocked(TeamVersion.findOne).mockResolvedValueOnce(ver as any);
        const result = await repo.find_by_team_and_version(hub_legacy_uuid(1), '1.0.0');
        expect(result).toEqual(ver);
    });

    it('find_by_team_and_version returns null', async () => {
        vi.mocked(TeamVersion.findOne).mockResolvedValueOnce(null);
        const result = await repo.find_by_team_and_version(hub_legacy_uuid(1), '9.9.9');
        expect(result).toBeNull();
    });

    it('find_latest_version returns highest semver, not most-recently-inserted', async () => {
        // Regression fixture for the "latest = published_at" bug. 1.1.0
        // must NOT win over 1.1.2 just because it was inserted last.
        vi.mocked(TeamVersion.findAll).mockResolvedValueOnce([
            { version: '1.1.2' }, { version: '1.0.2' }, { version: '1.1.0' },
        ] as any);
        const result = await repo.find_latest_version(hub_legacy_uuid(1));
        expect(result).toBe('1.1.2');
    });

    it('find_latest_version orders numerically (10 > 9)', async () => {
        vi.mocked(TeamVersion.findAll).mockResolvedValueOnce([
            { version: '1.9.0' }, { version: '1.10.0' }, { version: '1.2.0' },
        ] as any);
        const result = await repo.find_latest_version(hub_legacy_uuid(1));
        expect(result).toBe('1.10.0');
    });

    it('find_latest_version returns null when empty', async () => {
        vi.mocked(TeamVersion.findAll).mockResolvedValueOnce([]);
        const result = await repo.find_latest_version(hub_legacy_uuid(1));
        expect(result).toBeNull();
    });

    it('list_by_team_id returns versions sorted newest-first (semver, not insertion)', async () => {
        vi.mocked(TeamVersion.findAll).mockResolvedValueOnce([
            { version: '1.1.0', changelog: 'a', published_at: new Date('2026-01-03') },
            { version: '1.0.2', changelog: 'b', published_at: new Date('2026-01-02') },
            { version: '1.1.2', changelog: 'c', published_at: new Date('2026-01-01') },
        ] as any);
        const result = await repo.list_by_team_id(hub_legacy_uuid(1));
        expect(result.map((r) => r.version)).toEqual(['1.1.2', '1.1.0', '1.0.2']);
    });

    it('list_by_team_id returns empty array', async () => {
        vi.mocked(TeamVersion.findAll).mockResolvedValueOnce([]);
        const result = await repo.list_by_team_id(hub_legacy_uuid(999));
        expect(result).toEqual([]);
    });

    it('create inserts and returns id', async () => {
        vi.mocked(TeamVersion.create).mockResolvedValueOnce({ id: hub_legacy_uuid(5) } as any);
        const result = await repo.create(hub_legacy_uuid(1), '1.0.0', '', '/path', null, '[]', '{}', '', '{}', '{}');
        expect(result).toBe(hub_legacy_uuid(5));
    });

    it('delete_by_id calls destroy', async () => {
        await repo.delete_by_id(hub_legacy_uuid(5));
        expect(TeamVersion.destroy).toHaveBeenCalledWith({ where: { id: hub_legacy_uuid(5) } });
    });
});
