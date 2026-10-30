import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * One file of a team version (PLAN-team-bundle §2.2): the record of which files a version has and where their
 * bytes are. The content stays in storage, under its hash (`teams/<team_id>/files/<sha256>`); a draft is a
 * version, so its files are rows here too.
 */
export class TeamFile extends BaseModel {
    declare id: string;
    declare team_id: string;
    declare version_id: string;
    /** Relative to the team: `team.yml`, `roles/brief.md`, `README.md`. */
    declare path: string;
    /** The file name (`brief.md`). */
    declare name: string;
    declare size: number;
    declare sha256: string;
    declare content_type: string;
    /** Where the bytes are: `teams/<team_id>/files/<sha256>`. */
    declare storage_key: string;
    declare created_at: Date;

    static register(sequelize: Sequelize): void {
        TeamFile.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            team_id: { type: DataTypes.UUID, allowNull: false },
            version_id: { type: DataTypes.UUID, allowNull: false },
            path: { type: DataTypes.TEXT, allowNull: false },
            name: { type: DataTypes.TEXT, allowNull: false },
            size: { type: DataTypes.INTEGER, allowNull: false },
            sha256: { type: DataTypes.TEXT, allowNull: false },
            content_type: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'application/octet-stream' },
            storage_key: { type: DataTypes.TEXT, allowNull: false },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, {
            sequelize, tableName: 'team_files', schema: 'cliq',
            indexes: [{ unique: true, fields: ['version_id', 'path'] }, { fields: ['team_id'] }],
        });
    }
}
