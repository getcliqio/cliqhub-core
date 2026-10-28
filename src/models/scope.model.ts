import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export class Scope extends BaseModel {
    declare id: string;
    declare slug: string;
    declare display_name: string;
    /** The user who created it (null for a seeded scope). */
    declare owner_id: string | null;
    /** The org the scope belongs to; every scope has one (PLAN-team-visibility §3.1). */
    declare org_id: string | null;
    declare created_at: Date;
    /** 1 for the default scope (`@cliq`), whose public teams are on every org's Teams list (PLAN-team-visibility §3.6). */
    declare is_default: number;

    static register(sequelize: Sequelize): void {
        Scope.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            slug: { type: DataTypes.TEXT, unique: true, allowNull: false },
            display_name: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
            owner_id: { type: DataTypes.UUID, allowNull: true },
            org_id: { type: DataTypes.UUID, allowNull: true },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            is_default: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        }, { sequelize, tableName: 'scopes', schema: 'cliq' });
    }
}
