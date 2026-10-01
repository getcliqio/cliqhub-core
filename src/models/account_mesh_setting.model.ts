import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * Per-user mesh integration settings — which A2A/mesh provider is active,
 * stored provider credentials (JSONB), and whether a default realm should
 * automatically enable A2A on creation.
 *
 * Keyed by `user_id` (no surrogate PK). One row per user.
 */
export class AccountMeshSetting extends BaseModel {
    declare user_id: string;
    declare active_provider_id: string | null;
    declare providers: Record<string, Record<string, unknown>>;
    declare auto_enable_a2a_on_realm_create: boolean;
    declare created_at: number;
    declare updated_at: number;

    static register(sequelize: Sequelize): void {
        AccountMeshSetting.init({
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
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'account_mesh_settings',
            timestamps: false,
        });
    }
}

export type Account_mesh_setting_attributes = {
    user_id: string;
    active_provider_id: string | null;
    providers: Record<string, Record<string, unknown>>;
    auto_enable_a2a_on_realm_create: boolean;
    created_at: number;
    updated_at: number;
};
