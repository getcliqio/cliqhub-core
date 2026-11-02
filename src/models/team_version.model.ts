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
    /** Its zip once built (`teams/<team_id>/versions/<id>.zip`); its content is its files (PLAN-team-bundle §2.2). */
    declare package_path: string;
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
            published_at: { type: DataTypes.DATE, allowNull: true, defaultValue: DataTypes.NOW },
            saved_at: { type: DataTypes.DATE, allowNull: true },
        }, {
            sequelize, tableName: 'team_versions', schema: 'cliq',
            indexes: [{ unique: true, fields: ['team_id', 'version'] }],
        });
    }
}
