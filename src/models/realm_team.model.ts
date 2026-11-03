import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * A team a realm runs, at one version (PLAN-team-bundle S4.1). Replaces the `realms.team_list` JSON names: the
 * team and version are ids. Read and written only through `RealmTeamListService` (a guard test enforces it).
 */
export class RealmTeam extends BaseModel {
    declare id: string;
    declare realm_id: string;
    /** The catalog team (`teams.id`). */
    declare team_id: string;
    /** The version this realm runs (`team_versions.id`); its daemons install exactly this one. */
    declare version_id: string;
    declare created_at: Date;
    declare updated_at: Date;

    static register(sequelize: Sequelize): void {
        RealmTeam.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            realm_id: { type: DataTypes.TEXT, allowNull: false },
            team_id: { type: DataTypes.UUID, allowNull: false },
            version_id: { type: DataTypes.UUID, allowNull: false },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, {
            sequelize, tableName: 'realm_teams', schema: 'cliq',
            indexes: [{ unique: true, fields: ['realm_id', 'team_id'] }, { fields: ['team_id'] }],
        });
    }
}
