import { DataTypes, type Sequelize } from 'sequelize';
import { ModelConfig } from '../lib/model_options.js';
import { BaseModel } from './base_model.js';

/**
 * Docker container lifecycle record for a run phase.
 *
 * Tracks the container id, image, state transitions, and start/stop timestamps
 * (Unix ms). Tied to a run via `run_id` and optionally to the daemon that
 * launched it via `daemon_id`.
 */
export class Container extends BaseModel {
    declare id: string;
    declare run_id: string;
    declare daemon_id: string | null;
    declare container_id: string;
    declare image: string;
    declare state: string;
    declare started_at: number;
    declare stopped_at: number | null;

    static register(sequelize: Sequelize): void {
        Container.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            run_id: { type: DataTypes.TEXT, allowNull: false },
            daemon_id: { type: DataTypes.TEXT, allowNull: true },
            container_id: { type: DataTypes.TEXT, allowNull: false },
            image: { type: DataTypes.TEXT, allowNull: false },
            state: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'running' },
            started_at: { type: DataTypes.BIGINT, allowNull: false },
            stopped_at: { type: DataTypes.BIGINT },
        }, ModelConfig.table_options(sequelize, 'containers'));
    }
}

export type ContainerAttributes = {
    id: string;
    run_id: string;
    daemon_id: string | null;
    container_id: string;
    image: string;
    state: string;
    started_at: number;
    stopped_at: number | null;
};
