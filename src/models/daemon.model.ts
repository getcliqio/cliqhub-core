import { DataTypes, type Sequelize } from 'sequelize';
import { ModelConfig } from '../lib/model_options.js';
import { BaseModel } from './base_model.js';

/**
 * Daemon lifecycle status.
 *
 * - `online`   — heartbeat within the fresh threshold.
 * - `stale`    — heartbeat older than fresh but younger than deregister.
 * - `offline`  — explicitly deregistered (or heartbeat older than deregister).
 * - `removed`  — user or auto-sweep marked the daemon deleted. Row is
 *                kept as a tombstone so runs/workspaces still reference a
 *                real daemon row (the FK cascade would otherwise NULL out
 *                every historical run when a daemon's UUID recycles).
 *                Excluded from all user-visible listings.
 */
export type DaemonStatus = 'online' | 'stale' | 'offline' | 'removed';

export class Daemon extends BaseModel {
    declare id: string;
    declare api_key_hash: string;
    declare user_id: string | null;
    declare user_email: string | null;
    declare name: string | null;
    declare hostname: string | null;
    declare ip: string | null;
    declare port: number | null;
    declare public_url: string | null;
    declare status: DaemonStatus;
    declare last_heartbeat: number | null;
    declare capacity: number;
    declare created_at: number;
    declare last_registered_at: number;
    declare permissions: Record<string, unknown>;

    static register(sequelize: Sequelize): void {
        Daemon.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            api_key_hash: { type: DataTypes.TEXT, allowNull: false },
            user_id: { type: DataTypes.TEXT, allowNull: true },
            user_email: { type: DataTypes.TEXT, allowNull: true },
            name: { type: DataTypes.TEXT, allowNull: true },
            hostname: { type: DataTypes.TEXT, allowNull: true },
            ip: { type: DataTypes.TEXT, allowNull: true },
            port: { type: DataTypes.INTEGER, allowNull: true },
            public_url: { type: DataTypes.TEXT, allowNull: true },
            status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'online' },
            last_heartbeat: { type: DataTypes.BIGINT, allowNull: true },
            capacity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            last_registered_at: { type: DataTypes.BIGINT, allowNull: false },
            permissions: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        }, ModelConfig.table_options(sequelize, 'daemons'));
    }
}

export type DaemonAttributes = {
    id: string;
    api_key_hash: string;
    user_id: string | null;
    user_email: string | null;
    name: string | null;
    hostname: string | null;
    ip: string | null;
    port: number | null;
    public_url: string | null;
    status: DaemonStatus;
    last_heartbeat: number | null;
    capacity: number;
    created_at: number;
    last_registered_at: number;
    permissions: Record<string, unknown>;
};
