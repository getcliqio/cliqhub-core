import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export class Scope extends BaseModel {
    declare id: string;
    declare slug: string;
    declare display_name: string;
    /** Nullable for platform-owned scopes (e.g. 'cliq'). */
    declare owner_id: string | null;
    declare org_id: string | null;
    declare visibility: 'public' | 'private';
    declare scope_type: 'user' | 'org' | 'platform';
    declare created_at: Date;
    /** 1 for the platform default scope, 0 otherwise. Used by core_auth to grant universal access. */
    declare is_default: number;

    static register(sequelize: Sequelize): void {
        Scope.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            slug: { type: DataTypes.TEXT, unique: true, allowNull: false },
            display_name: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
            owner_id: { type: DataTypes.UUID, allowNull: true },
            org_id: { type: DataTypes.UUID, allowNull: true },
            visibility: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'public' },
            scope_type: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'user' },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            is_default: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        }, { sequelize, tableName: 'scopes', schema: 'cliq' });
    }
}
