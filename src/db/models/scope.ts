import { DataTypes, Model, type Sequelize } from 'sequelize';

export class Scope extends Model {
    declare id: string;
    declare slug: string;
    declare display_name: string;
    declare owner_id: string;
    declare org_id: string | null;
    declare visibility: 'public' | 'private';
    declare scope_type: 'user' | 'org';
    declare created_at: Date;
}

export function init_scope_model(sequelize: Sequelize): typeof Scope {
    Scope.init({
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        slug: { type: DataTypes.TEXT, unique: true, allowNull: false },
        display_name: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        owner_id: { type: DataTypes.UUID, allowNull: false },
        org_id: { type: DataTypes.UUID, allowNull: true },
        visibility: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'public' },
        scope_type: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'user' },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, { sequelize, tableName: 'scopes' });
    return Scope;
}
