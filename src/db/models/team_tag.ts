import { DataTypes, Model, type Sequelize } from 'sequelize';

export class TeamTag extends Model {
    declare team_id: string;
    declare tag: string;
}

export function init_team_tag_model(sequelize: Sequelize): typeof TeamTag {
    TeamTag.init({
        team_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        tag: { type: DataTypes.TEXT, primaryKey: true, allowNull: false },
    }, { sequelize, tableName: 'team_tags' });
    return TeamTag;
}
