import { DataTypes, Model, type Sequelize } from 'sequelize';

export class TeamVersion extends Model {
    declare id: string;
    declare team_id: string;
    declare version: string;
    declare changelog: string;
    declare package_path: string;
    declare workflow_json: string;
    /** Raw team.yml text — preserved verbatim for display. */
    declare manifest_yaml: string;
    declare readme: string;
    declare capability_json: string;
    declare agents_json: string;
    declare roles_json: string;
    declare cliq_version: string | null;
    declare tools: string;
    declare published_at: Date;
}

export function init_team_version_model(sequelize: Sequelize): typeof TeamVersion {
    TeamVersion.init({
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        team_id: { type: DataTypes.UUID, allowNull: false },
        version: { type: DataTypes.TEXT, allowNull: false },
        changelog: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        package_path: { type: DataTypes.TEXT, allowNull: false },
        workflow_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
        manifest_yaml: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        readme: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        capability_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
        agents_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
        roles_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '[]' },
        cliq_version: { type: DataTypes.TEXT, allowNull: true },
        tools: { type: DataTypes.TEXT, allowNull: false, defaultValue: '[]' },
        published_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        sequelize, tableName: 'team_versions',
        indexes: [{ unique: true, fields: ['team_id', 'version'] }],
    });
    return TeamVersion;
}
