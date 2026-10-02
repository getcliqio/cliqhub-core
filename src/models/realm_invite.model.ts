import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';
import type { InviteDecision, InviteStatus } from './account_invite.model.js';

/**
 * Pending/accepted invitations for users to join a realm.
 *
 * Mirrors `AccountInvite` (token columns included) at the realm level; roles
 * map to realm membership levels (`admin | operator | member`). On acceptance
 * the row is updated and the realm membership becomes active.
 */
export class RealmInvite extends BaseModel {
    declare id: string;
    declare realm_id: string;
    declare email: string;
    declare invited_by: string;
    declare token_hash: string;
    declare role: 'admin' | 'operator' | 'member';
    declare status: InviteStatus;
    declare created_at: Date;
    declare expires_at: Date;
    declare accepted_at: Date | null;
    declare accepted_user_id: string | null;
    /** The token encrypted with TOKEN_ENCRYPTION_KEY (lib/secure_token.ts), so resends reuse the link. */
    declare token_enc: string | null;
    /** How many times the invite email was sent (1 on create; "send again" adds one). */
    declare send_count: number;
    declare last_sent_at: Date | null;
    /** Reminders sent for the current expiry window (reset when the invite is sent again). */
    declare reminders_sent: number;
    /** When the invitee accepted or declined. */
    declare decided_at: Date | null;
    declare decision: InviteDecision | null;

    static register(sequelize: Sequelize): void {
        RealmInvite.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            realm_id: { type: DataTypes.TEXT, allowNull: false },
            email: { type: DataTypes.TEXT, allowNull: false },
            invited_by: { type: DataTypes.UUID, allowNull: false },
            token_hash: { type: DataTypes.TEXT, allowNull: false, unique: true },
            role: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'member' },
            status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            expires_at: { type: DataTypes.DATE, allowNull: false },
            accepted_at: { type: DataTypes.DATE, allowNull: true },
            accepted_user_id: { type: DataTypes.UUID, allowNull: true },
            token_enc: { type: DataTypes.TEXT, allowNull: true },
            send_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            last_sent_at: { type: DataTypes.DATE, allowNull: true },
            reminders_sent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            decided_at: { type: DataTypes.DATE, allowNull: true },
            decision: { type: DataTypes.TEXT, allowNull: true },
        }, {
            sequelize,
            tableName: 'realm_invites',
            schema: 'cliq',
            updatedAt: false,
            createdAt: 'created_at',
        });
    }
}
