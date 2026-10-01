import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export class RunLogLine extends BaseModel {
    declare id: string;
    declare run_id: string;
    declare created_at: number;
    declare level: string;
    declare message: string;
    declare daemon_id: string | null;
    declare workspace_id: string | null;
    declare team: string | null;
    declare realm_id: string | null;
    declare chunk_id: string | null;
    /** 'run' | 'system' | 'command' | 'http' — canonical bucket for filters/facets. */
    declare concern: string | null;

    static register(sequelize: Sequelize): void {
        RunLogLine.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            run_id: { type: DataTypes.TEXT, allowNull: false },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            level: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'info' },
            message: { type: DataTypes.TEXT, allowNull: false },
            daemon_id: { type: DataTypes.TEXT, allowNull: true },
            workspace_id: { type: DataTypes.TEXT, allowNull: true },
            team: { type: DataTypes.TEXT, allowNull: true },
            realm_id: { type: DataTypes.TEXT, allowNull: true },
            chunk_id: { type: DataTypes.TEXT, allowNull: true },
            concern: { type: DataTypes.TEXT, allowNull: true, defaultValue: 'run' },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'run_log_lines',
            timestamps: false,
            indexes: [
                { fields: ['created_at'] },
                { fields: ['realm_id', 'created_at'] },
                { fields: ['run_id'] },
                { fields: ['level'] },
                { fields: ['daemon_id'] },
                { fields: ['concern'] },
            ],
        });
    }
}

export type RunLogLineAttributes = {
    id: string;
    run_id: string;
    created_at: number;
    level: string;
    message: string;
    daemon_id: string | null;
    workspace_id: string | null;
    team: string | null;
    realm_id: string | null;
    chunk_id: string | null;
    concern: string | null;
};
