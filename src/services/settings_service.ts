import type { SettingsRepository } from '../repositories/settings_repository.js';

const CACHE_TTL_MS = 60_000;

interface CacheEntry { value: string; fetched_at: number; }

export class SettingsService {
    private _cache = new Map<string, CacheEntry>();
    constructor(private _settings_repo: SettingsRepository) {}

    async get_setting(key: string): Promise<string | null> {
        const cached = this._cache.get(key);
        if (cached && (Date.now() - cached.fetched_at) < CACHE_TTL_MS) return cached.value;
        const value = await this._settings_repo.find_by_key(key);
        if (value !== null) this._cache.set(key, { value, fetched_at: Date.now() });
        return value;
    }

    async set_setting(key: string, value: string): Promise<void> {
        const existing = await this._settings_repo.find_by_key(key);
        if (existing === null) {
            await this._settings_repo.create(key, value);
            this._cache.set(key, { value, fetched_at: Date.now() });
            return;
        }
        await this._settings_repo.update_by_key(key, value);
        this._cache.set(key, { value, fetched_at: Date.now() });
    }
}
