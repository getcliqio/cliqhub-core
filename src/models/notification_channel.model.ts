import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface NotificationChannelAttributes {
    id: string;
    /** Owning realm, or null for org-level channels. */
    realm_id: string | null;
    /** Owning org — set for org-level channels (realm_id IS NULL). */
    org_id: string | null;
    /** Owning user — set for personal channels, null for shared channels. */
    user_id: string | null;
    name: string;
    /**
     * Optional HMAC shared secret for webhook channels. Populated on
     * create/rotate. Deliverer reads this in preference to destination
     * config. Subsequent reads via get_channel show only the '***' mask.
     */
    secret: string | null;
    enabled: number;
    created_at: number;
    updated_at: number;
}

export type NotificationChannelModel = Model<NotificationChannelAttributes> & NotificationChannelAttributes;

/** Set by `init_notification_channel` — uses the store Sequelize's Model class. */
export let NotificationChannel: ModelStatic<NotificationChannelModel>;

export function init_notification_channel(sequelize: Sequelize): void {
    NotificationChannel = sequelize.define(
        'NotificationChannel',
        {
            id: { type: DataTypes.TEXT, primaryKey: true },
            realm_id: { type: DataTypes.TEXT, allowNull: true },
            org_id: { type: DataTypes.UUID, allowNull: true },
            user_id: { type: DataTypes.UUID, allowNull: true },
            name: { type: DataTypes.TEXT, allowNull: false },
            secret: { type: DataTypes.TEXT, allowNull: true },
            enabled: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        },
        {
            schema: 'cliq',
            tableName: 'notification_channels',
            timestamps: false,
            indexes: [
                { fields: ['realm_id'] },
                { fields: ['org_id'], name: 'notification_channels_org_id_idx' },
                { unique: true, fields: ['realm_id', 'name'] },
            ],
        },
    ) as ModelStatic<NotificationChannelModel>;
}
