/**
 * One row per WebhookDeliverer.deliver() attempt. Populated best-effort
 * from the deliverer itself — a failed insert must not fail the delivery.
 * See DESIGN-jira-forge-plugin slice 1.4.
 */

import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export class WebhookDelivery extends BaseModel {
    declare id: string;
    declare channel_id: string;
    declare event_type: string;
    declare url: string;
    /** HTTP status when a response was received; null on network error. */
    declare status_code: number | null;
    /** Elapsed wall time (ms) from fetch call to response/error. */
    declare response_ms: number | null;
    declare attempted_at: number;
    /** Populated on network error (thrown fetch) or non-2xx response summary. */
    declare error: string | null;

    static register(sequelize: Sequelize): void {
        WebhookDelivery.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            channel_id: { type: DataTypes.TEXT, allowNull: false },
            event_type: { type: DataTypes.TEXT, allowNull: false },
            url: { type: DataTypes.TEXT, allowNull: false },
            status_code: { type: DataTypes.INTEGER, allowNull: true },
            response_ms: { type: DataTypes.INTEGER, allowNull: true },
            attempted_at: { type: DataTypes.BIGINT, allowNull: false },
            error: { type: DataTypes.TEXT, allowNull: true },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'webhook_deliveries',
            timestamps: false,
            indexes: [
                { fields: ['channel_id', 'attempted_at'] },
                { fields: ['attempted_at'] },
            ],
        });
    }
}

export type WebhookDeliveryAttributes = {
    id: string;
    channel_id: string;
    event_type: string;
    url: string;
    status_code: number | null;
    response_ms: number | null;
    attempted_at: number;
    error: string | null;
};
