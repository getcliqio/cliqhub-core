import { randomUUID } from 'node:crypto';
import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * Realm-scoped agent setting override — a key/value pair that customises a
 * specific agent's behaviour within a realm (not tied to a user).
 *
 * These are the "realm defaults" applied to every run in the realm, distinct
 * from `UserRealmAgentSetting` which is per-user. Stored in the control-plane
 * schema, not the product registry.
 */
export class RealmAgentSetting extends BaseModel {
    declare id: string;
    declare realm_id: string;
    declare agent_name: string;
    declare setting_key: string;
    declare setting_value: string;
    declare created_at: Date;
    declare updated_at: Date;

    static register(sequelize: Sequelize): void {
        RealmAgentSetting.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => randomUUID() },
            realm_id: { type: DataTypes.TEXT, allowNull: false },
            agent_name: { type: DataTypes.STRING(128), allowNull: false },
            setting_key: { type: DataTypes.STRING(128), allowNull: false },
            setting_value: { type: DataTypes.TEXT, allowNull: false },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'realm_agent_settings',
            timestamps: true,
            underscored: true,
            indexes: [
                { unique: true, fields: ['realm_id', 'agent_name', 'setting_key'] },
            ],
        });
    }
}

export type RealmAgentSettingAttributes = {
    id: string;
    realm_id: string;
    agent_name: string;
    setting_key: string;
    setting_value: string;
    created_at: Date;
    updated_at: Date;
};
