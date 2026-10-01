import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * Per-destination notification row for a HUG review.
 *
 * Each reviewer destination (user or shared channel) in each reviewer
 * group gets one row. This is the unit of policy evaluation and the
 * audit trail for who responded and when.
 */
export class ReviewNotification extends BaseModel {
    declare id: string;
    declare review_id: string;
    /** Which reviewer group this destination belongs to. */
    declare group_idx: number;
    /** Original reviewer string — e.g. "elan", "ops-slack". */
    declare channel_target: string;
    /** Resolved notification_channels.id (if target matched a channel). */
    declare channel_id: string | null;
    /** Resolved user ID (if target matched an org member). NULL for shared channels. */
    declare user_id: string | null;
    /** User ID of whoever actually responded (from auth context). */
    declare responded_by: string | null;
    declare responded_at: Date | null;
    /** The decision: PASS, REJECT, ROUTE:*. */
    declare action: string | null;
    declare comment: string | null;
    declare created_at: Date;

    static register(sequelize: Sequelize): void {
        ReviewNotification.init({
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
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'review_notifications',
            timestamps: false,
            indexes: [
                { fields: ['review_id'] },
                { fields: ['user_id'], where: { user_id: { [Symbol.for('ne')]: null } } },
            ],
        });
    }
}

export type ReviewNotificationAttributes = {
    id: string;
    review_id: string;
    group_idx: number;
    channel_target: string;
    channel_id: string | null;
    user_id: string | null;
    responded_by: string | null;
    responded_at: Date | null;
    action: string | null;
    comment: string | null;
    created_at: Date;
};
