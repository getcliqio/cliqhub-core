import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * A single chat message within a HUG review.
 *
 * Messages are exchanged between the AI agent ("assistant" role) and
 * the human reviewer ("user" role). The review_id links to the parent
 * review. The sender_id is the Hub user_id for user messages, NULL for
 * agent messages.
 */
export class ReviewMessage extends BaseModel {
    declare id: string;
    declare review_id: string;
    /** "user" (human reviewer) or "assistant" (AI agent). */
    declare role: string;
    /** Message text content. */
    declare text: string;
    /** Hub user_id of the sender. NULL for agent messages. */
    declare sender_id: string | null;
    declare created_at: Date;

    static register(sequelize: Sequelize): void {
        ReviewMessage.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            review_id: { type: DataTypes.TEXT, allowNull: false },
            role: { type: DataTypes.TEXT, allowNull: false },
            text: { type: DataTypes.TEXT, allowNull: false },
            sender_id: { type: DataTypes.UUID, allowNull: true },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'review_chat_messages',
            timestamps: false,
            indexes: [
                { fields: ['review_id', 'created_at'] },
            ],
        });
    }
}

/** @deprecated Use ReviewMessage directly */
export type ReviewMessageModel = ReviewMessage;

export type ReviewMessageAttributes = {
    id: string;
    review_id: string;
    role: string;
    text: string;
    sender_id: string | null;
    created_at: Date;
};
