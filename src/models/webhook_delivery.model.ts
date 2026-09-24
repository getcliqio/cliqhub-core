import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

/**
 * One row per WebhookDeliverer.deliver() attempt. Populated best-effort
 * from the deliverer itself — a failed insert must not fail the delivery.
 * See DESIGN-jira-forge-plugin slice 1.4.
 */
export interface WebhookDeliveryAttributes {
    id: string;
    channel_id: string;
    event_type: string;
    url: string;
    /** HTTP status when a response was received; null on network error. */
    status_code: number | null;
    /** Elapsed wall time (ms) from fetch call to response/error. */
    response_ms: number | null;
    attempted_at: number;
    /** Populated on network error (thrown fetch) or non-2xx response summary. */
    error: string | null;
}

export type WebhookDeliveryModel = Model<WebhookDeliveryAttributes> & WebhookDeliveryAttributes;

export let WebhookDelivery: ModelStatic<WebhookDeliveryModel>;

export function init_webhook_delivery(sequelize: Sequelize): void {
    WebhookDelivery = sequelize.define(
        'WebhookDelivery',
        {
            id: { type: DataTypes.TEXT, primaryKey: true },
            channel_id: { type: DataTypes.TEXT, allowNull: false },
            event_type: { type: DataTypes.TEXT, allowNull: false },
            url: { type: DataTypes.TEXT, allowNull: false },
            status_code: { type: DataTypes.INTEGER, allowNull: true },
            response_ms: { type: DataTypes.INTEGER, allowNull: true },
            attempted_at: { type: DataTypes.BIGINT, allowNull: false },
            error: { type: DataTypes.TEXT, allowNull: true },
        },
        {
            schema: 'cliq',
            tableName: 'webhook_deliveries',
            timestamps: false,
            indexes: [
                { fields: ['channel_id', 'attempted_at'] },
                { fields: ['attempted_at'] },
            ],
        },
    ) as ModelStatic<WebhookDeliveryModel>;
}
