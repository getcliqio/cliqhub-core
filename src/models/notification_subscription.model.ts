import { randomUUID } from 'node:crypto';
import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface NotificationSubscriptionAttributes {
    id?: string;
    /** Set for realm bindings; null for account-scoped bindings. */
    realm_id: string | null;
    channel_id: string;
    event: string;
    scope: string;
    created_at: number;
}

export type NotificationSubscriptionModel =
    Model<NotificationSubscriptionAttributes> & NotificationSubscriptionAttributes;

/** Set by `init_notification_subscription` — uses the store Sequelize's Model class. */
export let NotificationSubscription: ModelStatic<NotificationSubscriptionModel>;

export function init_notification_subscription(sequelize: Sequelize): void {
    NotificationSubscription = sequelize.define(
        'NotificationSubscription',
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => randomUUID() },
            realm_id: { type: DataTypes.TEXT, allowNull: true },
            channel_id: { type: DataTypes.TEXT, allowNull: false },
            event: { type: DataTypes.TEXT, allowNull: false },
            scope: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'global' },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        },
        {
            schema: 'cliq',
            tableName: 'notification_subscriptions',
            timestamps: false,
            indexes: [
                { fields: ['realm_id'] },
                { fields: ['realm_id', 'event'] },
            ],
        },
    ) as ModelStatic<NotificationSubscriptionModel>;
}
