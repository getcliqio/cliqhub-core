import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * Lifecycle of an account: `invited` until the person accepts an invite or
 * sets their first password, then `active`; `suspended` while `suspended_at`
 * is set. A deleted account keeps its status and gets `deleted_at`.
 */
export type UserStatus = 'invited' | 'active' | 'suspended';

/**
 * A person's account. Usernames and emails stay taken after a soft delete
 * (`deleted_at`); the unique indexes cover deleted rows.
 */
export class User extends BaseModel {
    declare id: string;
    /**
     * The column is nullable: it is NULL for an invited person who has not
     * chosen a username yet (status `invited`). It is typed as a string because
     * every user that can sign in or own anything has one; code that reads
     * invited users must handle the NULL.
     */
    declare username: string;
    declare display_name: string;
    declare email: string;
    /** Null while the person has never set a password (invited). */
    declare password_hash: string | null;
    declare role: 'user' | 'admin';
    declare status: UserStatus;
    declare deleted_at: Date | null;
    declare suspended_at: Date | null;
    declare suspended_reason: string;
    declare created_at: Date;
    /** Personal default realm (account-owned). */
    declare default_realm_id: string | null;
    /** General-purpose user preferences (alert toggles, UI settings, etc.). */
    declare preferences: Record<string, unknown>;

    static register(sequelize: Sequelize): void {
        User.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            username: { type: DataTypes.TEXT, unique: true, allowNull: true },
            display_name: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
            email: { type: DataTypes.TEXT, unique: true, allowNull: false },
            password_hash: { type: DataTypes.TEXT, allowNull: true },
            role: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'user' },
            status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'active' },
            deleted_at: { type: DataTypes.DATE, allowNull: true },
            suspended_at: { type: DataTypes.DATE, allowNull: true },
            suspended_reason: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            default_realm_id: { type: DataTypes.TEXT, allowNull: true },
            preferences: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        }, { sequelize, tableName: 'users', schema: 'cliq' });
    }
}
