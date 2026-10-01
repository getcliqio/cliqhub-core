import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * Tag applied to a team for discovery and filtering.
 *
 * Composite PK of `(team_id, tag)`. Tags are free-form lowercase strings.
 * No surrogate key. Used by the registry search endpoint to filter teams
 * by capability (e.g. `nlp`, `vision`, `data`).
 */
export class TeamTag extends BaseModel {
    declare team_id: string;
    declare tag: string;

    static register(sequelize: Sequelize): void {
        TeamTag.init({
            team_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
            tag: { type: DataTypes.TEXT, primaryKey: true, allowNull: false },
        }, { sequelize, tableName: 'team_tags', schema: 'cliq' });
    }
}
