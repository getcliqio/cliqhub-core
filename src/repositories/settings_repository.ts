import { Setting } from '../models/index.js';
import { BaseRepository } from './base_repository.js';

export class SettingsRepository extends BaseRepository<Setting> {
    protected readonly model = Setting;
    async find_by_key(key: string): Promise<string | null> {
        const row = await Setting.findByPk(key, { attributes: ['value'], raw: true });
        if (!row) return null;
        return row.value;
    }

    async create(key: string, value: string): Promise<void> {
        await Setting.create({ key, value });
    }

    async update_by_key(key: string, value: string): Promise<void> {
        await Setting.update({ value, updated_at: new Date() }, { where: { key } });
    }
}
