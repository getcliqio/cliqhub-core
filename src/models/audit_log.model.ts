import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * Immutable audit trail for admin actions performed through Hub.
 *
 * `admin_id` is the user who performed the action; `action` is a dot-namespaced
 * verb (e.g. `user.update`, `org.delete`); `details` is a JSON string with
 * before/after context. Rows are never deleted.
 */
export class AuditLog extends BaseModel {
    declare id: string;
    declare admin_id: string;
    declare action: string;
    declare target_type: string;
    declare target_id: string;
    declare details: string;
    declare created_at: Date;

    static register(sequelize: Sequelize): void {
        AuditLog.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            admin_id: { type: DataTypes.UUID, allowNull: false },
            action: { type: DataTypes.TEXT, allowNull: false },
            target_type: { type: DataTypes.TEXT, allowNull: false },
            target_id: { type: DataTypes.TEXT, allowNull: false },
            details: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, { sequelize, tableName: 'audit_log', schema: 'cliq' });
    }
}
