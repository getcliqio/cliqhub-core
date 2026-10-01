import { randomUUID } from 'node:crypto';
import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export class NotificationSubscription extends BaseModel {
    declare id: string;
    /** Set for realm bindings; null for account-scoped bindings. */
    declare realm_id: string | null;
    declare channel_id: string;
    declare event: string;
    declare scope: string;
    declare created_at: number;

    static register(sequelize: Sequelize): void {
        NotificationSubscription.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => randomUUID() },
            realm_id: { type: DataTypes.TEXT, allowNull: true },
            channel_id: { type: DataTypes.TEXT, allowNull: false },
            event: { type: DataTypes.TEXT, allowNull: false },
            scope: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'global' },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'notification_subscriptions',
            timestamps: false,
            indexes: [
                { fields: ['realm_id'] },
                { fields: ['realm_id', 'event'] },
            ],
        });
    }
}

export type NotificationSubscriptionAttributes = {
    id?: string;
    realm_id: string | null;
    channel_id: string;
    event: string;
    scope: string;
    created_at: number;
};
