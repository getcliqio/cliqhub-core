import { DataTypes, Model, type Sequelize } from 'sequelize';

export class User extends Model {
    declare id: string;
    declare username: string;
    declare display_name: string;
    declare email: string;
    declare password_hash: string;
    declare role: 'user' | 'admin';
    declare suspended_at: Date | null;
    declare suspended_reason: string;
    declare created_at: Date;
    /** Personal default realm (account-owned). */
    declare default_realm_id: string | null;
    /** General-purpose user preferences (alert toggles, UI settings, etc.). */
    declare preferences: Record<string, unknown>;
}

export function init_user_model(sequelize: Sequelize): typeof User {
    User.init({
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        username: { type: DataTypes.TEXT, unique: true, allowNull: false },
        display_name: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        email: { type: DataTypes.TEXT, unique: true, allowNull: false },
        password_hash: { type: DataTypes.TEXT, allowNull: false },
        role: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'user' },
        suspended_at: { type: DataTypes.DATE, allowNull: true },
        suspended_reason: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        default_realm_id: { type: DataTypes.TEXT, allowNull: true },
        preferences: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    }, { sequelize, tableName: 'users' });
    return User;
}
