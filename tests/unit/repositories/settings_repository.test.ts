import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';
setup_sequelize_mocks();
import { Setting } from '../../../src/db/models/index.js';
import { SettingsRepository } from '../../../src/repositories/settings_repository.js';

describe('SettingsRepository', () => {
    let repo: SettingsRepository;
    beforeEach(() => { vi.clearAllMocks(); repo = new SettingsRepository(); });

    it('find_by_key returns value when found', async () => {
        vi.mocked(Setting.findByPk).mockResolvedValueOnce({ value: 'hello' } as any);
        const result = await repo.find_by_key('my_key');
        expect(result).toBe('hello');
    });

    it('find_by_key returns null when not found', async () => {
        vi.mocked(Setting.findByPk).mockResolvedValueOnce(null);
        const result = await repo.find_by_key('missing');
        expect(result).toBeNull();
    });

    it('create inserts new setting', async () => {
        await repo.create('key1', 'val1');
        expect(Setting.create).toHaveBeenCalledWith({ key: 'key1', value: 'val1' });
    });

    it('update_by_key modifies existing setting', async () => {
        await repo.update_by_key('key1', 'val2');
        expect(Setting.update).toHaveBeenCalledWith(expect.objectContaining({ value: 'val2' }), expect.objectContaining({ where: { key: 'key1' } }));
    });
});
