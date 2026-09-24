import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import { Org } from '../../../src/db/models/index.js';
import { OrgRepository } from '../../../src/repositories/org_repository.js';

describe('OrgRepository', () => {
    let repo: OrgRepository;

    beforeEach(() => {
        vi.clearAllMocks();
        repo = new OrgRepository();
    });

    it('find_by_id returns org when found', async () => {
        const org = { id: hub_legacy_uuid(1), slug: 'acme', display_name: 'Acme', created_at: '2025-01-01' };
        vi.mocked(Org.findByPk).mockResolvedValueOnce(org as any);
        const result = await repo.find_by_id(hub_legacy_uuid(1));
        expect(result).toEqual(org);
    });

    it('find_by_id returns null when not found', async () => {
        vi.mocked(Org.findByPk).mockResolvedValueOnce(null);
        const result = await repo.find_by_id(hub_legacy_uuid(999));
        expect(result).toBeNull();
    });

    it('find_by_slug returns id when found', async () => {
        vi.mocked(Org.findOne).mockResolvedValueOnce({ id: hub_legacy_uuid(1) } as any);
        const result = await repo.find_by_slug('acme');
        expect(result).toEqual({ id: hub_legacy_uuid(1) });
    });

    it('create inserts org and returns id', async () => {
        vi.mocked(Org.create).mockResolvedValueOnce({ id: hub_legacy_uuid(5) } as any);
        const result = await repo.create('acme', 'Acme Corp');
        expect(result).toBe(hub_legacy_uuid(5));
    });

    it('update_display_name modifies name', async () => {
        await repo.update_display_name(hub_legacy_uuid(1), 'New Name');
        expect(Org.update).toHaveBeenCalledWith(
            { display_name: 'New Name' },
            { where: { id: hub_legacy_uuid(1) } },
        );
    });

    it('delete removes org', async () => {
        await repo.delete_by_id(hub_legacy_uuid(1));
        expect(Org.destroy).toHaveBeenCalledWith({ where: { id: hub_legacy_uuid(1) } });
    });
});
