import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * Work-in-progress team — a user's unpublished workflow before it is
 * submitted to the registry as a versioned `TeamVersion`.
 *
 * `team_json` stores the full workflow definition as a JSON string. Drafts
 * are scoped to a single user (`user_id`) and are not visible to others.
 * Publishing a draft creates a `Team` + `TeamVersion` and deletes the draft.
 */
export class Draft extends BaseModel {
    declare id: string;
    declare user_id: string;
    declare title: string;
    declare team_json: string;
    declare created_at: Date;
    declare updated_at: Date;

    static register(sequelize: Sequelize): void {
        Draft.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            user_id: { type: DataTypes.UUID, allowNull: false },
            title: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'Untitled Team' },
            team_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, { sequelize, tableName: 'drafts', schema: 'cliq' });
    }
}
