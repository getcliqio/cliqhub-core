import { DataTypes, type Sequelize } from 'sequelize';
import { ModelConfig } from '../lib/model_options.js';
import { BaseModel } from './base_model.js';

/**
 * Workspace — a local directory context bound to a daemon, team, and scope.
 *
 * A workspace is the working directory a daemon uses when executing a team.
 * It links a `daemon_id` (which machine), a `scope_id` (who owns the work),
 * and optionally a `team_id` (which workflow). The `path` is absolute on the
 * daemon host. Created automatically on team install or via `cliq workspace`.
 */
export class Workspace extends BaseModel {
    declare id: string;
    declare path: string;
    declare name: string | null;
    declare scope_id: string | null;
    declare team_id: string | null;
    declare daemon_id: string | null;
    declare created_at: number;
    declare updated_at: number;

    static register(sequelize: Sequelize): void {
        Workspace.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            path: { type: DataTypes.TEXT, allowNull: false },
            name: { type: DataTypes.TEXT },
            scope_id: { type: DataTypes.TEXT },
            team_id: { type: DataTypes.TEXT },
            daemon_id: { type: DataTypes.TEXT, allowNull: true },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        }, ModelConfig.table_options(sequelize, 'workspaces', {
            indexes: [{ unique: true, fields: ['daemon_id', 'path'] }],
        }));
    }
}

export type WorkspaceAttributes = {
    id: string;
    path: string;
    name: string | null;
    scope_id: string | null;
    team_id: string | null;
    daemon_id: string | null;
    created_at: number;
    updated_at: number;
};
