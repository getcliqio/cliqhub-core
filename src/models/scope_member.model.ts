import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * Scope membership join table — grants a user access to a scope.
 *
 * Composite PK of `(scope_id, user_id)`. No surrogate key. Membership gives
 * the user read/write access to teams published under that scope, subject to
 * the scope's visibility setting.
 */
export class ScopeMember extends BaseModel {
    declare scope_id: string;
    declare user_id: string;

    static register(sequelize: Sequelize): void {
        ScopeMember.init({
            scope_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
            user_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        }, { sequelize, tableName: 'scope_members', schema: 'cliq' });
    }
}
