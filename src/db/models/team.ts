import { DataTypes, Model, type Sequelize } from 'sequelize';

export class Team extends Model {
    declare id: string;
    declare name: string;
    declare scope: string | null;
    declare scope_type: 'user' | 'org' | null;
    declare description: string;
    declare author_id: string | null;
    declare license: string;
    declare visibility: 'public' | 'private' | 'draft';
    declare listed: number;
    declare created_at: Date;
    declare updated_at: Date;
    declare install_count: number;
}

export function init_team_model(sequelize: Sequelize): typeof Team {
    Team.init({
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        name: { type: DataTypes.TEXT, allowNull: false },
        scope: { type: DataTypes.TEXT, allowNull: true },
        scope_type: { type: DataTypes.TEXT, allowNull: true },
        description: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        author_id: { type: DataTypes.UUID, allowNull: true },
        license: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'MIT' },
        visibility: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'public' },
        listed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        install_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    }, {
        sequelize, tableName: 'teams',
        indexes: [{ unique: true, fields: ['name', 'scope'] }],
    });
    return Team;
}
