import { DataTypes, type Sequelize } from 'sequelize';
import { ModelConfig } from '../lib/model_options.js';
import { BaseModel } from './base_model.js';

export class Run extends BaseModel {
    declare run_id: string;
    declare workspace_id: string;
    declare team_id: string;
    declare daemon_id: string | null;
    /**
     * Realm this run was created for. Snapshotted at run-create time so
     * historical runs stay reachable to the realm even if the daemon row
     * is later removed or re-enrolled with a fresh UUID. Nullable for
     * runs created before this column existed (backfilled where possible).
     */
    declare realm_id: string | null;
    declare parent_run_id: string | null;
    declare parent_phase: string | null;
    /** Top-level ancestor run_id. For root runs, equals own run_id. */
    declare root_run_id: string | null;
    /** JSON array of parent phase names leading to this run. Root = '[]'. */
    declare call_path: string | null;
    /** Length of call_path — avoids JSON parsing for depth queries. */
    declare call_depth: number;
    /** Map iteration key. Null for non-map runs. */
    declare iteration_key: string | null;
    declare run_name: string | null;
    declare org_id: string | null;
    declare state: string;
    declare inputs: string | null;
    declare error: string | null;
    declare execution_type: string;
    declare current_pid: number | null;
    declare current_phase: string | null;
    declare external_id: string | null;
    declare context_labels: string | null;
    /**
     * Hub action lease — when this epoch-ms passes while the run is still
     * non-terminal, RunReaper marks it crashed even if the daemon heartbeats.
     * Null = no lease (legacy rows / completed).
     */
    declare lease_expires_at: number | null;
    declare started_at: number;
    declare completed_at: number | null;

    static register(sequelize: Sequelize): void {
        Run.init({
            run_id: { type: DataTypes.TEXT, primaryKey: true },
            workspace_id: { type: DataTypes.TEXT, allowNull: false },
            team_id: { type: DataTypes.TEXT, allowNull: false },
            daemon_id: { type: DataTypes.TEXT, allowNull: true },
            realm_id: { type: DataTypes.TEXT, allowNull: true },
            parent_run_id: { type: DataTypes.TEXT },
            parent_phase: { type: DataTypes.TEXT },
            root_run_id: { type: DataTypes.TEXT },
            call_path: { type: DataTypes.TEXT },
            call_depth: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            iteration_key: { type: DataTypes.TEXT, allowNull: true },
            run_name: { type: DataTypes.TEXT },
            org_id: { type: DataTypes.TEXT, allowNull: true },
            state: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'running' },
            inputs: { type: DataTypes.TEXT },
            error: { type: DataTypes.TEXT },
            execution_type: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'local' },
            current_pid: { type: DataTypes.INTEGER },
            current_phase: { type: DataTypes.TEXT },
            external_id: { type: DataTypes.TEXT, allowNull: true },
            context_labels: { type: DataTypes.TEXT, allowNull: true },
            lease_expires_at: { type: DataTypes.BIGINT, allowNull: true },
            started_at: { type: DataTypes.BIGINT, allowNull: false },
            completed_at: { type: DataTypes.BIGINT },
        }, ModelConfig.table_options(sequelize, 'team_runs'));
    }
}

export type RunAttributes = {
    run_id: string;
    workspace_id: string;
    team_id: string;
    daemon_id: string | null;
    realm_id: string | null;
    parent_run_id: string | null;
    parent_phase: string | null;
    root_run_id: string | null;
    call_path: string | null;
    call_depth: number;
    iteration_key: string | null;
    run_name: string | null;
    org_id: string | null;
    state: string;
    inputs: string | null;
    error: string | null;
    execution_type: string;
    current_pid: number | null;
    current_phase: string | null;
    external_id: string | null;
    context_labels: string | null;
    lease_expires_at: number | null;
    started_at: number;
    completed_at: number | null;
};
