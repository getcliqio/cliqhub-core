import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

/**
 * Per-destination notification row for a HUG review.
 *
 * Each reviewer destination (user or shared channel) in each reviewer
 * group gets one row. This is the unit of policy evaluation and the
 * audit trail for who responded and when.
 */
export interface ReviewNotificationAttributes {
    id: string;
    review_id: string;
    /** Which reviewer group this destination belongs to. */
    group_idx: number;
    /** Original reviewer string — e.g. "elan", "ops-slack". */
    channel_target: string;
    /** Resolved notification_channels.id (if target matched a channel). */
    channel_id: string | null;
    /** Resolved user ID (if target matched an org member). NULL for shared channels. */
    user_id: string | null;
    /** User ID of whoever actually responded (from auth context). */
    responded_by: string | null;
    responded_at: Date | null;
    /** The decision: PASS, REJECT, ROUTE:*. */
    action: string | null;
    comment: string | null;
    created_at: Date;
}

export type ReviewNotificationModel =
    Model<ReviewNotificationAttributes> & ReviewNotificationAttributes;

export let ReviewNotification: ModelStatic<ReviewNotificationModel>;

export function init_review_notification(sequelize: Sequelize): void {
    ReviewNotification = sequelize.define(
        'ReviewNotification',
        {
            id: { type: DataTypes.TEXT, primaryKey: true },
            review_id: { type: DataTypes.TEXT, allowNull: false },
            group_idx: { type: DataTypes.SMALLINT, allowNull: false },
            channel_target: { type: DataTypes.TEXT, allowNull: false },
            channel_id: { type: DataTypes.TEXT, allowNull: true },
            user_id: { type: DataTypes.UUID, allowNull: true },
            responded_by: { type: DataTypes.UUID, allowNull: true },
            responded_at: { type: DataTypes.DATE, allowNull: true },
            action: { type: DataTypes.TEXT, allowNull: true },
            comment: { type: DataTypes.TEXT, allowNull: true },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        },
        {
            schema: 'cliq',
            tableName: 'review_notifications',
            timestamps: false,
            indexes: [
                { fields: ['review_id'] },
                { fields: ['user_id'], where: { user_id: { [Symbol.for('ne')]: null } } },
            ],
        },
    ) as ModelStatic<ReviewNotificationModel>;
}
