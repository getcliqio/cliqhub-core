import { Op } from 'sequelize';

import { DaemonConfigRepository } from '../repositories/daemon_config_repository.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('svc.hub_settings');

const GLOBAL = '__global__';
const repo = new DaemonConfigRepository();

export class SettingsService {

    static async get(key: string, daemon_id = GLOBAL) {
        log.debug('get', { key, daemon_id });
        return repo.find_one({ daemon_id, key });
    }

    static async set(key: string, value: string, daemon_id = GLOBAL): Promise<boolean> {
        log.debug('set', { key, daemon_id });
        const now = Date.now();
        const existing = await repo.find_one({ daemon_id, key });

        if (existing) {
            await existing.update({ value, updated_at: now });
            return true;
        }

        await repo.create_one({ daemon_id, key, value, updated_at: now });
        return false;
    }

    static async list(daemon_id = GLOBAL) {
        log.debug('list', { daemon_id });
        return repo.find_all({ daemon_id }, { order: [['key', 'ASC']] });
    }

    static async list_by_prefix(prefix: string, daemon_id = GLOBAL) {
        log.debug('list_by_prefix', { prefix, daemon_id });
        return repo.find_all(
            { daemon_id, key: { [Op.like]: `${prefix}%` } },
            { order: [['key', 'ASC']] },
        );
    }

    static async remove(key: string, daemon_id = GLOBAL): Promise<boolean> {
        log.debug('remove', { key, daemon_id });
        const deleted = await repo.delete_where({ daemon_id, key });
        return deleted > 0;
    }
}
