import { DataTypes, type Sequelize } from 'sequelize';
import { IdFactory } from '../lib/ids.js';
import { ModelConfig } from '../lib/model_options.js';
import { BaseModel } from './base_model.js';

/**
 * Raw stdout/stderr log chunk for a run.
 *
 * Chunks are appended as the agent writes output; `created_at` (Unix ms)
 * provides ordering. The dashboard streams these in real time via the SSE
 * endpoint and replays them on reconnect from the last received chunk.
 */
export class RunLog extends BaseModel {
    declare id: string;
    declare run_id: string;
    declare chunk: string;
    declare created_at: number;

    static register(sequelize: Sequelize): void {
        RunLog.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => IdFactory.new_id() },
            run_id: { type: DataTypes.TEXT, allowNull: false },
            chunk: { type: DataTypes.TEXT, allowNull: false },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        }, ModelConfig.table_options(sequelize, 'run_logs', {
            indexes: [
                { fields: ['run_id', 'created_at', 'id'], name: 'idx_run_logs_run_created' },
            ],
        }));
    }
}

export type RunLogAttributes = {
    id: string;
    run_id: string;
    chunk: string;
    created_at: number;
};
