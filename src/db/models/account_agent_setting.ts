import { DataTypes, Model, type Sequelize } from 'sequelize';

/**
 * Per-user agent settings — the "account-level" defaults a user
 * configures once on the hub. Values are stored as TEXT (typically
 * short strings like API keys). Realm-scoped overrides live in a
 * separate table so we can compute the effective value cleanly.
 *
 * PK: (user_id, agent_name, setting_key).
 */
export class AccountAgentSetting extends Model {
    declare user_id: string;
    declare agent_name: string;
    declare setting_key: string;
    declare value: string;
    declare updated_at: Date;
}

export function init_account_agent_setting_model(sequelize: Sequelize): typeof AccountAgentSetting {
    AccountAgentSetting.init({
        user_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        agent_name: { type: DataTypes.TEXT, primaryKey: true, allowNull: false },
        setting_key: { type: DataTypes.TEXT, primaryKey: true, allowNull: false },
        value: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, { sequelize, tableName: 'account_agent_settings' });
    return AccountAgentSetting;
}
