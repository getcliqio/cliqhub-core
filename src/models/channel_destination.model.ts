import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

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

export class ChannelDestination extends BaseModel {
    declare id: string;
    declare channel_id: string;
    declare type: string;
    declare config: Record<string, unknown>;
    declare created_at: number;

    static register(sequelize: Sequelize): void {
        ChannelDestination.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            channel_id: { type: DataTypes.TEXT, allowNull: false },
            type: { type: DataTypes.TEXT, allowNull: false },
            config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'channel_destinations',
            timestamps: false,
            indexes: [
                { fields: ['channel_id'], name: 'channel_destinations_channel_id_idx' },
                { fields: ['type'], name: 'channel_destinations_type_idx' },
            ],
        });
    }
}
