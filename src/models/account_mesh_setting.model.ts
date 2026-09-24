import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface Account_mesh_setting_attributes {
    user_id: string;
    active_provider_id: string | null;
    providers: Record<string, Record<string, unknown>>;
    auto_enable_a2a_on_realm_create: boolean;
    created_at: number;
    updated_at: number;
}

export type Account_mesh_setting_model =
    Model<Account_mesh_setting_attributes> & Account_mesh_setting_attributes;

export let AccountMeshSetting: ModelStatic<Account_mesh_setting_model>;

export function init_account_mesh_setting(sequelize: Sequelize): void {
    AccountMeshSetting = sequelize.define(
        'AccountMeshSetting',
        {
            user_id: { type: DataTypes.TEXT, primaryKey: true },
            active_provider_id: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
            providers: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            auto_enable_a2a_on_realm_create: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        },
        {
            schema: 'cliq',
            tableName: 'account_mesh_settings',
            timestamps: false,
        },
    ) as ModelStatic<Account_mesh_setting_model>;
}
