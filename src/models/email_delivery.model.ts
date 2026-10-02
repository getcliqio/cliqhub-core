import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * What an email was about: an invite (org, owner or realm), a password link
 * (`password_resets` row), or a user (mail about the account itself, such as
 * "Your password was changed").
 */
export type EmailSubjectType = 'invite' | 'reset' | 'user';

/**
 * One email the Email channel tried to send, successful or not. Invite lists
 * show these as `deliveries` (sent / reminder). Never holds the link or body.
 */
export class EmailDelivery extends BaseModel {
    declare id: string;
    declare subject_type: EmailSubjectType;
    declare subject_id: string;
    /** Event name that produced the email (e.g. `invite.org.sent`). */
    declare event: string;
    /** `events.id` of that event. */
    declare event_id: string | null;
    declare org_id: string | null;
    declare channel_id: string | null;
    /** Recipient address. */
    declare to: string;
    declare sent_at: Date;
    declare ok: boolean;
    /** Provider message id (Brevo `messageId`) when accepted. */
    declare provider_message_id: string | null;
    /** Short failure reason when `ok` is false; never contains the key or the body. */
    declare error: string | null;

    static register(sequelize: Sequelize): void {
        EmailDelivery.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            subject_type: { type: DataTypes.TEXT, allowNull: false },
            subject_id: { type: DataTypes.UUID, allowNull: false },
            event: { type: DataTypes.TEXT, allowNull: false },
            event_id: { type: DataTypes.TEXT, allowNull: true },
            org_id: { type: DataTypes.UUID, allowNull: true },
            channel_id: { type: DataTypes.TEXT, allowNull: true },
            to: { type: DataTypes.TEXT, allowNull: false },
            sent_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            ok: { type: DataTypes.BOOLEAN, allowNull: false },
            provider_message_id: { type: DataTypes.TEXT, allowNull: true },
            error: { type: DataTypes.TEXT, allowNull: true },
        }, {
            sequelize,
            tableName: 'email_deliveries',
            schema: 'cliq',
            timestamps: false,
        });
    }
}
