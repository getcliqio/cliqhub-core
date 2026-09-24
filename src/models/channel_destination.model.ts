import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface ChannelDestinationAttributes {
    id: string;
    /** Owning channel — CASCADE deletes destinations when channel is removed. */
    channel_id: string;
    /** Destination type: cliqhub, slack, email, webhook, http, jira, channel_ref. */
    type: string;
    /** Type-specific config (webhook_url, address, headers, etc.). */
    config: Record<string, unknown>;
    created_at: number;
}

export type ChannelDestinationModel =
    Model<ChannelDestinationAttributes> & ChannelDestinationAttributes;

/** Set by `init_channel_destination` — uses the store Sequelize's Model class. */
export let ChannelDestination: ModelStatic<ChannelDestinationModel>;

export function init_channel_destination(sequelize: Sequelize): void {
    ChannelDestination = sequelize.define(
        'ChannelDestination',
        {
            id: { type: DataTypes.TEXT, primaryKey: true },
            channel_id: { type: DataTypes.TEXT, allowNull: false },
            type: { type: DataTypes.TEXT, allowNull: false },
            config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        },
        {
            schema: 'cliq',
            tableName: 'channel_destinations',
            timestamps: false,
            indexes: [
                { fields: ['channel_id'], name: 'channel_destinations_channel_id_idx' },
                { fields: ['type'], name: 'channel_destinations_type_idx' },
            ],
        },
    ) as ModelStatic<ChannelDestinationModel>;
}
