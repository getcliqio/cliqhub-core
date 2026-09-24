import { randomUUID } from 'node:crypto';
import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface RealmAgentSettingAttributes {
    id: string;
    realm_id: string;
    agent_name: string;
    setting_key: string;
    setting_value: string;
    created_at: Date;
    updated_at: Date;
}

export type RealmAgentSettingModel = Model<RealmAgentSettingAttributes> & RealmAgentSettingAttributes;

export let RealmAgentSetting: ModelStatic<RealmAgentSettingModel>;

export function init_realm_agent_setting(sequelize: Sequelize): void {
    RealmAgentSetting = sequelize.define(
        'RealmAgentSetting',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => randomUUID() },
            realm_id: { type: DataTypes.TEXT, allowNull: false },
            agent_name: { type: DataTypes.STRING(128), allowNull: false },
            setting_key: { type: DataTypes.STRING(128), allowNull: false },
            setting_value: { type: DataTypes.TEXT, allowNull: false },
        },
        {
            schema: 'cliq',
            tableName: 'realm_agent_settings',
            timestamps: true,
            underscored: true,
            indexes: [
                { unique: true, fields: ['realm_id', 'agent_name', 'setting_key'] },
            ],
        },
    ) as ModelStatic<RealmAgentSettingModel>;
}
