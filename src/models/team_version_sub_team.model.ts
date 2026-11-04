import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * One sub-team call in a published team version (PLAN-team-bundle S8): which phase calls which team, at a pinned
 * version or the latest. Written once, when the version is published (its files never change); the team reads and
 * the tree views (S9) are built from these rows.
 */
export class TeamVersionSubTeam extends BaseModel {
    declare id: string;
    /** The calling version (`team_versions.id`). */
    declare version_id: string;
    /** Order in the team.yml. */
    declare position: number;
    /** The calling phase. */
    declare phase: string;
    /** The ref as written (`@acme/leaf`, `@acme/leaf@1.0.0`). */
    declare ref: string;
    /** The called team, when it exists on CliqHub (an unpinned ref may name a team not published yet). */
    declare team_id: string | null;
    /** The pinned version; null when the ref takes the latest. */
    declare pinned_version_id: string | null;
    /** From a dynamic `map`'s `teams:` list: the phase may call it, depending on its items. */
    declare may_call: boolean;
    declare created_at: Date;

    static register(sequelize: Sequelize): void {
        TeamVersionSubTeam.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            version_id: { type: DataTypes.UUID, allowNull: false },
            position: { type: DataTypes.INTEGER, allowNull: false },
            phase: { type: DataTypes.TEXT, allowNull: false },
            ref: { type: DataTypes.TEXT, allowNull: false },
            team_id: { type: DataTypes.UUID, allowNull: true },
            pinned_version_id: { type: DataTypes.UUID, allowNull: true },
            may_call: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, {
            sequelize, tableName: 'team_version_sub_teams', schema: 'cliq',
            indexes: [{ fields: ['version_id'] }, { fields: ['team_id'] }],
        });
    }
}
