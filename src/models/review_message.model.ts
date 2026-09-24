import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

/**
 * A single chat message within a HUG review.
 *
 * Messages are exchanged between the AI agent ("assistant" role) and
 * the human reviewer ("user" role). The review_id links to the parent
 * review. The sender_id is the Hub user_id for user messages, NULL for
 * agent messages.
 */
export interface ReviewMessageAttributes {
    id: string;
    review_id: string;
    /** "user" (human reviewer) or "assistant" (AI agent). */
    role: string;
    /** Message text content. */
    text: string;
    /** Hub user_id of the sender. NULL for agent messages. */
    sender_id: string | null;
    created_at: Date;
}

export type ReviewMessageModel =
    Model<ReviewMessageAttributes> & ReviewMessageAttributes;

export let ReviewMessage: ModelStatic<ReviewMessageModel>;

export function init_review_message(sequelize: Sequelize): void {
    ReviewMessage = sequelize.define(
        'ReviewMessage',
        {
            id: { type: DataTypes.TEXT, primaryKey: true },
            review_id: { type: DataTypes.TEXT, allowNull: false },
            role: { type: DataTypes.TEXT, allowNull: false },
            text: { type: DataTypes.TEXT, allowNull: false },
            sender_id: { type: DataTypes.UUID, allowNull: true },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        },
        {
            schema: 'cliq',
            tableName: 'review_chat_messages',
            timestamps: false,
            indexes: [
                { fields: ['review_id', 'created_at'] },
            ],
        },
    ) as ModelStatic<ReviewMessageModel>;
}
