import { DataTypes, Model, type Sequelize } from 'sequelize';

export class AuditLog extends Model {
    declare id: string;
    declare admin_id: string;
    declare action: string;
    declare target_type: string;
    declare target_id: string;
    declare details: string;
    declare created_at: Date;
}

export function init_audit_log_model(sequelize: Sequelize): typeof AuditLog {
    AuditLog.init({
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        admin_id: { type: DataTypes.UUID, allowNull: false },
        action: { type: DataTypes.TEXT, allowNull: false },
        target_type: { type: DataTypes.TEXT, allowNull: false },
        target_id: { type: DataTypes.TEXT, allowNull: false },
        details: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, { sequelize, tableName: 'audit_log' });
    return AuditLog;
}
