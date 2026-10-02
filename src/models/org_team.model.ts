import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * A team in an org's library. A team joins the org (from the marketplace, or
 * because one of the org's scopes owns it) before the org's realms add it.
 * Composite PK `(org_id, team_id)`.
 */
export class OrgTeam extends BaseModel {
    declare org_id: string;
    declare team_id: string;
    declare added_by: string | null;
    declare added_at: Date;

    static register(sequelize: Sequelize): void {
        OrgTeam.init({
            org_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
            team_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
            added_by: { type: DataTypes.UUID, allowNull: true },
            added_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, { sequelize, tableName: 'org_teams', schema: 'cliq', timestamps: false });
    }
}
