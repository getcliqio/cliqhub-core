import { DataTypes, type Sequelize } from 'sequelize';
import { ModelConfig } from '../lib/model_options.js';
import { BaseModel } from './base_model.js';

export class WorkspaceTeam extends BaseModel {
    declare workspace_id: string;
    declare team_id: string;
    declare assembled_at: number;
    /** JSON-serialized DaemonConfig snapshot taken at assembly time. */
    declare config_snapshot: string | null;

    static register(sequelize: Sequelize): void {
        WorkspaceTeam.init({
            workspace_id: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
            team_id: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
            assembled_at: { type: DataTypes.BIGINT, allowNull: false },
            config_snapshot: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
        }, ModelConfig.table_options(sequelize, 'workspace_teams'));
    }
}

export type WorkspaceTeamAttributes = {
    workspace_id: string;
    team_id: string;
    assembled_at: number;
    config_snapshot: string | null;
};
