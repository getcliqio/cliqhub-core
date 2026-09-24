import { DataTypes, Model, type Sequelize } from 'sequelize';

/**
 * Per-realm agent settings — snapshot-on-create copies of the
 * user's account-level agent defaults, editable independently of
 * the account row. When a realm is created, every account row for
 * the creator is cloned here with the new `realm_id`; from that
 * point on, the realm row diverges freely.
 *
 * Two escape hatches:
 *   - "Reset to global" per key — the UI re-copies the current
 *     account value on top of the realm row.
 *   - Deleting a realm cascades (via ON DELETE CASCADE from the
 *     realm_id-side FK; enforced in the SQL migration since realm
 *     rows live in the `cliq` schema and this table lives in
 *     `public`, so we drop rows in `RealmService.remove` instead).
 *
 * PK: (user_id, realm_id, agent_name, setting_key).
 */
export class RealmAgentSetting extends Model {
    declare user_id: string;
    declare realm_id: string;
    declare agent_name: string;
    declare setting_key: string;
    declare value: string;
    declare updated_at: Date;
}

export function init_realm_agent_setting_model(sequelize: Sequelize): typeof RealmAgentSetting {
    RealmAgentSetting.init({
        user_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        realm_id: { type: DataTypes.TEXT, primaryKey: true, allowNull: false },
        agent_name: { type: DataTypes.TEXT, primaryKey: true, allowNull: false },
        setting_key: { type: DataTypes.TEXT, primaryKey: true, allowNull: false },
        value: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, { sequelize, tableName: 'realm_agent_settings' });
    return RealmAgentSetting;
}
