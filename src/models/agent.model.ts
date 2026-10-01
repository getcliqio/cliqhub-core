import { DataTypes, type Sequelize } from 'sequelize';
import { ModelConfig } from '../lib/model_options.js';
import { BaseModel } from './base_model.js';

/**
 * Registered agent definition — describes a single agent that a daemon has
 * made available (local process, Docker container, or remote HTTP endpoint).
 *
 * `manifest` holds the raw YAML/JSON capability descriptor. `transport` is
 * one of `local | docker | http`. The optional `daemon_id` ties the agent to
 * a specific daemon; null means it is a hub-level registration.
 */
export class Agent extends BaseModel {
    declare id: string;
    declare daemon_id: string | null;
    declare name: string;
    declare version: string | null;
    declare description: string | null;
    declare agent_type: string;
    declare transport: string;
    declare command: string | null;
    declare host: string | null;
    declare port: number | null;
    declare url: string | null;
    declare install_path: string | null;
    declare manifest: string;
    declare dockerfile: string | null;
    declare dependencies: string | null;
    declare created_at: number;
    declare updated_at: number;

    static register(sequelize: Sequelize): void {
        Agent.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            daemon_id: { type: DataTypes.TEXT, allowNull: true },
            name: { type: DataTypes.TEXT, allowNull: false },
            version: { type: DataTypes.TEXT },
            description: { type: DataTypes.TEXT },
            agent_type: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'exec' },
            transport: { type: DataTypes.TEXT, allowNull: false },
            command: { type: DataTypes.TEXT },
            host: { type: DataTypes.TEXT },
            port: { type: DataTypes.INTEGER },
            url: { type: DataTypes.TEXT },
            install_path: { type: DataTypes.TEXT },
            manifest: { type: DataTypes.TEXT, allowNull: false },
            dockerfile: { type: DataTypes.TEXT },
            dependencies: { type: DataTypes.TEXT },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        }, ModelConfig.table_options(sequelize, 'agents', {
            indexes: [{ unique: true, fields: ['daemon_id', 'name'] }],
        }));
    }
}

export type AgentAttributes = {
    id: string;
    daemon_id: string | null;
    name: string;
    version: string | null;
    description: string | null;
    agent_type: string;
    transport: string;
    command: string | null;
    host: string | null;
    port: number | null;
    url: string | null;
    install_path: string | null;
    manifest: string;
    dockerfile: string | null;
    dependencies: string | null;
    created_at: number;
    updated_at: number;
};
