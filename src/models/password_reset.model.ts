import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/** Why a password link was issued: a new user's first password, or a reset. */
export type PasswordLinkPurpose = 'setup' | 'reset';

/**
 * A "Set your password" or "Reset your password" link.
 *
 * The token is stored as `token_hash` (lookup) plus `token_enc` (AES-GCM, so
 * a resend rebuilds the same link); see lib/secure_token.ts. At most one open
 * (unused) link exists per user and purpose: asking again bumps
 * `send_count`, `last_sent_at` and `expires_at` on the same row.
 */
export class PasswordReset extends BaseModel {
    declare id: string;
    declare user_id: string;
    declare purpose: PasswordLinkPurpose;
    declare token_hash: string;
    declare token_enc: string;
    declare expires_at: Date;
    /** Set when the password was set through this link (or the link was retired). */
    declare used_at: Date | null;
    declare send_count: number;
    declare last_sent_at: Date;
    /** Site admin who asked for it; null for the public "Forgot password" form and for setup links of self-service flows. */
    declare requested_by: string | null;
    declare created_at: Date;

    static register(sequelize: Sequelize): void {
        PasswordReset.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            user_id: { type: DataTypes.UUID, allowNull: false },
            purpose: { type: DataTypes.TEXT, allowNull: false },
            token_hash: { type: DataTypes.TEXT, allowNull: false, unique: true },
            token_enc: { type: DataTypes.TEXT, allowNull: false },
            expires_at: { type: DataTypes.DATE, allowNull: false },
            used_at: { type: DataTypes.DATE, allowNull: true },
            send_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            last_sent_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            requested_by: { type: DataTypes.UUID, allowNull: true },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, {
            sequelize,
            tableName: 'password_resets',
            schema: 'cliq',
            timestamps: false,
        });
    }
}
