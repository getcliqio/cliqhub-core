import { DataTypes, type Sequelize } from 'sequelize';
import { ModelConfig } from '../lib/model_options.js';
import { BaseModel } from './base_model.js';

/**
 * Key-value configuration store for a daemon instance.
 *
 * Composite PK of `(daemon_id, key)`. Used to persist runtime settings
 * (e.g. log level, concurrency limits) that the daemon reads on startup or
 * via a live-reload signal. `__global__` is the reserved daemon_id for
 * hub-wide defaults.
 */
export class DaemonConfig extends BaseModel {
    declare daemon_id: string;
    declare key: string;
    declare value: string;
    declare updated_at: number;

    static register(sequelize: Sequelize): void {
        DaemonConfig.init({
            daemon_id: { type: DataTypes.TEXT, primaryKey: true, defaultValue: '__global__' },
            key: { type: DataTypes.TEXT, primaryKey: true },
            value: { type: DataTypes.TEXT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        }, ModelConfig.table_options(sequelize, 'daemon_config'));
    }
}

export type DaemonConfigAttributes = {
    daemon_id: string;
    key: string;
    value: string;
    updated_at: number;
};
