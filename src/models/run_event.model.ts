import { DataTypes, type Sequelize } from 'sequelize';
import { IdFactory } from '../lib/ids.js';
import { ModelConfig } from '../lib/model_options.js';
import { BaseModel } from './base_model.js';

/**
 * Structured event emitted by an agent during a run phase.
 *
 * `event_type` is a namespaced string (e.g. `agent.started`, `tool.called`).
 * `payload_json` carries the full event body. Events are append-only and
 * used by the dashboard for real-time run tracing and the post-run audit log.
 */
export class RunEvent extends BaseModel {
    declare id: string;
    declare run_id: string;
    declare event_type: string;
    declare phase: string | null;
    declare agent: string | null;
    declare payload_json: string | null;
    declare created_at: number;

    static register(sequelize: Sequelize): void {
        RunEvent.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => IdFactory.new_id() },
            run_id: { type: DataTypes.TEXT, allowNull: false },
            event_type: { type: DataTypes.TEXT, allowNull: false },
            phase: { type: DataTypes.TEXT },
            agent: { type: DataTypes.TEXT },
            payload_json: { type: DataTypes.TEXT },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        }, ModelConfig.table_options(sequelize, 'team_run_events', {
            indexes: [
                { fields: ['run_id', 'created_at', 'id'], name: 'idx_run_events_run_created' },
                { fields: ['created_at'], name: 'idx_run_events_created_at' },
            ],
        }));
    }
}

export type RunEventAttributes = {
    id: string;
    run_id: string;
    event_type: string;
    phase: string | null;
    agent: string | null;
    payload_json: string | null;
    created_at: number;
};
