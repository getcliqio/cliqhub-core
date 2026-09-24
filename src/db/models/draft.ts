import { DataTypes, Model, type Sequelize } from 'sequelize';

export class Draft extends Model {
    declare id: string;
    declare user_id: string;
    declare title: string;
    declare team_json: string;
    declare created_at: Date;
    declare updated_at: Date;
}

export function init_draft_model(sequelize: Sequelize): typeof Draft {
    Draft.init({
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        user_id: { type: DataTypes.UUID, allowNull: false },
        title: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'Untitled Team' },
        team_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, { sequelize, tableName: 'drafts' });
    return Draft;
}
