import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * Per-user per-realm agent settings — snapshot-on-create copies of the
 * user's account-level agent defaults, editable independently of the
 * account row. Stored in `user_realm_agent_settings` to avoid collision
 * with the store's `realm_agent_settings` (per-realm, no user_id).
 *
 * PK: (user_id, realm_id, agent_name, setting_key).
 */
export class UserRealmAgentSetting extends BaseModel {
    declare user_id: string;
    declare realm_id: string;
    declare agent_name: string;
    declare setting_key: string;
    declare value: string;
    declare updated_at: Date;

    static register(sequelize: Sequelize): void {
        UserRealmAgentSetting.init({
            user_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
            realm_id: { type: DataTypes.TEXT, primaryKey: true, allowNull: false },
            agent_name: { type: DataTypes.TEXT, primaryKey: true, allowNull: false },
            setting_key: { type: DataTypes.TEXT, primaryKey: true, allowNull: false },
            value: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
            updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, { sequelize, tableName: 'user_realm_agent_settings', schema: 'cliq' });
    }
}
