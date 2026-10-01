import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export class InAppNotification extends BaseModel {
    declare id: string;
    declare event: string;
    declare title: string | null;
    declare message: string | null;
    declare realm_id: string | null;
    /** Org boundary — denormalized from realm or channel for org-scoped queries. */
    declare org_id: string | null;
    /** Target user for per-user notifications. NULL = realm-wide (existing behavior). */
    declare user_id: string | null;
    declare team: string | null;
    declare run_id: string | null;
    declare phase: string | null;
    declare severity: string | null;
    /** Denormalized from payload for HUG event queries. */
    declare review_id: string | null;
    declare payload_json: string;
    declare created_at: number;

    static register(sequelize: Sequelize): void {
        InAppNotification.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            event: { type: DataTypes.TEXT, allowNull: false },
            title: { type: DataTypes.TEXT, allowNull: true },
            message: { type: DataTypes.TEXT, allowNull: true },
            realm_id: { type: DataTypes.TEXT, allowNull: true },
            org_id: { type: DataTypes.UUID, allowNull: true },
            user_id: { type: DataTypes.UUID, allowNull: true },
            team: { type: DataTypes.TEXT, allowNull: true },
            run_id: { type: DataTypes.TEXT, allowNull: true },
            phase: { type: DataTypes.TEXT, allowNull: true },
            severity: { type: DataTypes.TEXT, allowNull: true },
            review_id: { type: DataTypes.TEXT, allowNull: true },
            payload_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'in_app_notifications',
            timestamps: false,
            indexes: [
                { fields: ['created_at'] },
                { fields: ['realm_id'] },
                { fields: ['org_id'] },
                { fields: ['event'] },
                { fields: ['user_id'] },
                { fields: ['review_id'] },
            ],
        });
    }
}

export type InAppNotificationAttributes = {
    id: string;
    event: string;
    title: string | null;
    message: string | null;
    realm_id: string | null;
    org_id: string | null;
    user_id: string | null;
    team: string | null;
    run_id: string | null;
    phase: string | null;
    severity: string | null;
    review_id: string | null;
    payload_json: string;
    created_at: number;
};
