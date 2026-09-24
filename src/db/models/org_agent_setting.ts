/**
 * OrgAgentSetting — org-scoped agent credential defaults.
 *
 * Replaces `account_agent_settings` (which was per-user). In the
 * org-as-account model, credentials are shared across all org members.
 * Realm-level overrides in `cliq.realm_agent_settings` take precedence.
 *
 * PK: (org_id, agent_name, setting_key).
 */

import { DataTypes, Model, type Sequelize } from 'sequelize';

export class OrgAgentSetting extends Model {
    declare org_id: string;
    declare agent_name: string;
    declare setting_key: string;
    declare value: string;
    declare updated_by: string | null;
    declare updated_at: Date;
}

export function init_org_agent_setting_model(sequelize: Sequelize): typeof OrgAgentSetting {
    OrgAgentSetting.init({
        org_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        agent_name: { type: DataTypes.TEXT, primaryKey: true, allowNull: false },
        setting_key: { type: DataTypes.TEXT, primaryKey: true, allowNull: false },
        value: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        updated_by: { type: DataTypes.UUID, allowNull: true },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        sequelize,
        tableName: 'org_agent_settings',
        indexes: [
            { fields: ['org_id'], name: 'org_agent_settings_org_idx' },
        ],
    });
    return OrgAgentSetting;
}
