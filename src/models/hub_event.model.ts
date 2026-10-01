import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * Hub-level structured event log — records observable lifecycle events
 * across realms, runs, orgs, and agents.
 *
 * `type` is a dot-namespaced string (e.g. `run.started`, `realm.created`).
 * `payload_json` holds the full event body. Events are append-only and
 * consumed by the notification fan-out pipeline and the dashboard feed.
 */
export class HubEvent extends BaseModel {
    declare id: string;
    declare type: string;
    declare occurred_at: string;
    declare realm_id: string | null;
    declare org_id: string | null;
    declare team: string | null;
    declare run_id: string | null;
    declare phase: string | null;
    declare daemon_id: string | null;
    declare title: string | null;
    declare message: string | null;
    declare severity: string | null;
    declare payload_json: string;
    declare actor_id: string | null;
    declare created_at: number;

    static register(sequelize: Sequelize): void {
        HubEvent.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            type: { type: DataTypes.TEXT, allowNull: false },
            occurred_at: { type: DataTypes.TEXT, allowNull: false },
            realm_id: { type: DataTypes.TEXT, allowNull: true },
            org_id: { type: DataTypes.TEXT, allowNull: true },
            team: { type: DataTypes.TEXT, allowNull: true },
            run_id: { type: DataTypes.TEXT, allowNull: true },
            phase: { type: DataTypes.TEXT, allowNull: true },
            daemon_id: { type: DataTypes.TEXT, allowNull: true },
            title: { type: DataTypes.TEXT, allowNull: true },
            message: { type: DataTypes.TEXT, allowNull: true },
            severity: { type: DataTypes.TEXT, allowNull: true },
            payload_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
            actor_id: { type: DataTypes.TEXT, allowNull: true },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'events',
            timestamps: false,
            indexes: [
                { fields: ['type'] },
                { fields: ['realm_id'] },
                { fields: ['created_at'] },
            ],
        });
    }
}

export type HubEventAttributes = {
    id: string;
    type: string;
    occurred_at: string;
    realm_id: string | null;
    org_id: string | null;
    team: string | null;
    run_id: string | null;
    phase: string | null;
    daemon_id: string | null;
    title: string | null;
    message: string | null;
    severity: string | null;
    payload_json: string;
    actor_id: string | null;
    created_at: number;
};
