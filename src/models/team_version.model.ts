import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export class TeamVersion extends BaseModel {
    declare id: string;
    declare team_id: string;
    /** `draft` (its files still editable) or `published` (fixed). PLAN-team-bundle §2.2. */
    declare status: 'draft' | 'published';
    /** Set when published; a draft has none. */
    declare version: string | null;
    declare changelog: string;
    declare package_path: string;
    declare workflow_json: string;
    /** Raw team.yml text — preserved verbatim for display. */
    declare manifest_yaml: string;
    declare readme: string;
    declare capability_json: string;
    declare agents_json: string;
    declare roles_json: string;
    /** dependencies.yml text ('' when the team has none). */
    declare dependencies_yaml: string;
    declare cliq_version: string | null;
    declare tools: string;
    declare published_at: Date | null;
    /** When a draft's files last changed (upload / remove); picks a team's open draft. */
    declare saved_at: Date | null;

    static register(sequelize: Sequelize): void {
        TeamVersion.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            team_id: { type: DataTypes.UUID, allowNull: false },
            status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'published' },
            version: { type: DataTypes.TEXT, allowNull: true },
            changelog: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
            package_path: { type: DataTypes.TEXT, allowNull: false },
            workflow_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
            manifest_yaml: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
            readme: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
            capability_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
            agents_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
            roles_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '[]' },
            dependencies_yaml: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
            cliq_version: { type: DataTypes.TEXT, allowNull: true },
            tools: { type: DataTypes.TEXT, allowNull: false, defaultValue: '[]' },
            published_at: { type: DataTypes.DATE, allowNull: true, defaultValue: DataTypes.NOW },
            saved_at: { type: DataTypes.DATE, allowNull: true },
        }, {
            sequelize, tableName: 'team_versions', schema: 'cliq',
            indexes: [{ unique: true, fields: ['team_id', 'version'] }],
        });
    }
}
