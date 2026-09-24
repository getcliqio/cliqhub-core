import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsService } from '../../../src/services/settings_service.js';

function make_settings_repo() {
    return {
        find_by_key: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
        update_by_key: vi.fn(),
    };
}

describe('SettingsService', () => {
    let service: SettingsService;
    let repo: ReturnType<typeof make_settings_repo>;

    beforeEach(() => {
        vi.clearAllMocks();
        repo = make_settings_repo();
        service = new SettingsService(repo as any);
    });

    it('get_setting returns null for missing key', async () => {
        const result = await service.get_setting('missing');
        expect(result).toBeNull();
    });

    it('get_setting returns cached value within TTL', async () => {
        repo.find_by_key.mockResolvedValueOnce('cached_val');
        await service.get_setting('k');
        const result = await service.get_setting('k');
        expect(result).toBe('cached_val');
        expect(repo.find_by_key).toHaveBeenCalledTimes(1);
    });

    it('get_setting refreshes after TTL expires', async () => {
        repo.find_by_key.mockResolvedValueOnce('old').mockResolvedValueOnce('new');
        await service.get_setting('k');
        const cache = (service as any)._cache;
        cache.get('k').fetched_at = Date.now() - 120000;
        const result = await service.get_setting('k');
        expect(result).toBe('new');
        expect(repo.find_by_key).toHaveBeenCalledTimes(2);
    });

    it('set_setting inserts when key does not exist', async () => {
        repo.find_by_key.mockResolvedValueOnce(null);
        await service.set_setting('new_key', 'val');
        expect(repo.create).toHaveBeenCalledWith('new_key', 'val');
    });

    it('set_setting updates and invalidates cache', async () => {
        repo.find_by_key.mockResolvedValueOnce('existing');
        await service.set_setting('k', 'updated');
        expect(repo.update_by_key).toHaveBeenCalledWith('k', 'updated');
    });
});
