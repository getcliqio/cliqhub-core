import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export class OrgMember extends BaseModel {
    declare org_id: string;
    declare user_id: string;
    /** @deprecated Use role_id instead. Kept for backward compat during migration. */
    declare role: string;
    /** FK into org_roles — the member's assigned role. */
    declare role_id: string | null;

    static register(sequelize: Sequelize): void {
        OrgMember.init({
            org_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
            user_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
            role: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'member' },
            role_id: { type: DataTypes.UUID, allowNull: true },
        }, { sequelize, tableName: 'org_members', schema: 'cliq' });
    }
}
