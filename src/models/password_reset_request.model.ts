import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * One public "Forgot password" request, kept to enforce the per-email hourly
 * limit (config/identity_lifecycle.ts). Requests for unknown
 * emails are recorded too, so the limit never reveals whether an account exists.
 */
export class PasswordResetRequest extends BaseModel {
    declare id: string;
    /** Normalized (trimmed, lowercase) email as typed. */
    declare email: string;
    declare created_at: Date;

    static register(sequelize: Sequelize): void {
        PasswordResetRequest.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            email: { type: DataTypes.TEXT, allowNull: false },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, {
            sequelize,
            tableName: 'password_reset_requests',
            schema: 'cliq',
            timestamps: false,
        });
    }
}
