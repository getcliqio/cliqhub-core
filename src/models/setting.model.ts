import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * Hub-wide key/value settings store.
 *
 * Used for operational flags and configuration that must survive restarts and
 * be consistent across multiple hub instances (e.g. feature flags, default
 * quota limits). `key` is the PK; values are plain text. Modified via the
 * `/v1/settings/*` admin API.
 */
export class Setting extends BaseModel {
    declare key: string;
    declare value: string;
    declare updated_at: Date;

    static register(sequelize: Sequelize): void {
        Setting.init({
            key: { type: DataTypes.TEXT, primaryKey: true },
            value: { type: DataTypes.TEXT, allowNull: false },
            updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, { sequelize, tableName: 'settings', schema: 'cliq' });
    }
}
