import { Op } from 'sequelize';

import { DaemonConfig } from '../models/index.js';

const GLOBAL = '__global__';

export class SettingsService {

    static async get(key: string, daemon_id = GLOBAL) {
        return DaemonConfig.findOne({ where: { daemon_id, key } });
    }

    static async set(key: string, value: string, daemon_id = GLOBAL): Promise<boolean> {
        const now = Date.now();
        const existing = await DaemonConfig.findOne({ where: { daemon_id, key } });

        if (existing) {
            await existing.update({ value, updated_at: now });
            return true;
        }

        await DaemonConfig.create({ daemon_id, key, value, updated_at: now });
        return false;
    }

    static async list(daemon_id = GLOBAL) {
        return DaemonConfig.findAll({
            where: { daemon_id },
            order: [['key', 'ASC']],
        });
    }

    static async list_by_prefix(prefix: string, daemon_id = GLOBAL) {
        return DaemonConfig.findAll({
            where: { daemon_id, key: { [Op.like]: `${prefix}%` } },
            order: [['key', 'ASC']],
        });
    }

    static async remove(key: string, daemon_id = GLOBAL): Promise<boolean> {
        const deleted = await DaemonConfig.destroy({ where: { daemon_id, key } });
        return deleted > 0;
    }
}
