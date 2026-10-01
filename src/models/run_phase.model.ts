import { DataTypes, type Sequelize } from 'sequelize';
import { ModelConfig } from '../lib/model_options.js';
import { BaseModel } from './base_model.js';

export class RunPhase extends BaseModel {
    declare run_id: string;
    declare phase: string;
    declare status: string;
    declare agent_name: string | null;
    declare attempt: number;
    /** Workflow order from create_many (0-based). Not alphabetical by phase name. */
    declare sequence: number;
    declare dispatched_at: number | null;
    declare started_at: number | null;
    declare completed_at: number | null;
    declare exit_code: number | null;
    declare error: string | null;

    static register(sequelize: Sequelize): void {
        RunPhase.init({
            run_id: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
            phase: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
            status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
            agent_name: { type: DataTypes.TEXT },
            attempt: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            sequence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            dispatched_at: { type: DataTypes.BIGINT },
            started_at: { type: DataTypes.BIGINT },
            completed_at: { type: DataTypes.BIGINT },
            exit_code: { type: DataTypes.INTEGER },
            error: { type: DataTypes.TEXT },
        }, ModelConfig.table_options(sequelize, 'team_run_phases'));
    }
}

export type RunPhaseAttributes = {
    run_id: string;
    phase: string;
    status: string;
    agent_name: string | null;
    attempt: number;
    sequence: number;
    dispatched_at: number | null;
    started_at: number | null;
    completed_at: number | null;
    exit_code: number | null;
    error: string | null;
};
