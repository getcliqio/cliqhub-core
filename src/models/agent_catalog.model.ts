/**
 * AgentCatalog model — Hub-owned SoT for platform agents (`cliq.agent_catalog`).
 *
 * System agents (built-ins) have `org_id = NULL`, `is_system = true`.
 * Custom agents belong to an org (`org_id` set, `is_system = false`).
 *
 * Uniqueness: (COALESCE(org_id, zero-UUID), name, COALESCE(version, '__none__'))
 * — enforced by a functional index in the schema migration, not by Sequelize.
 *
 * Soft-delete via `deleted` / `deleted_at`.
 * Do not confuse with store `cliq.agents` (daemon-local DaemonAgent registry).
 */

import { randomUUID } from 'node:crypto';
import { DataTypes, Model, Sequelize } from 'sequelize';

export interface AgentCatalogAttributes {
    id: string;
    name: string;
    version: string | null;
    description: string | null;
    agent_type: string;
    manifest: Record<string, unknown>;
    org_id: string | null;
    is_system: boolean;
    deleted: boolean;
    deleted_at: number | null;
    created_at: Date;
    updated_at: Date;
}

export class AgentCatalog extends Model<AgentCatalogAttributes> implements AgentCatalogAttributes {
    declare id: string;
    declare name: string;
    declare version: string | null;
    declare description: string | null;
    declare agent_type: string;
    declare manifest: Record<string, unknown>;
    declare org_id: string | null;
    declare is_system: boolean;
    declare deleted: boolean;
    declare deleted_at: number | null;
    declare created_at: Date;
    declare updated_at: Date;
}

/** Initialize the AgentCatalog Sequelize model on the given connection. */
export function init_agent_catalog(sequelize: Sequelize): void {
    AgentCatalog.init(
        {
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => randomUUID() },
            name: { type: DataTypes.STRING(128), allowNull: false },
            version: { type: DataTypes.STRING(32), allowNull: true },
            description: { type: DataTypes.TEXT, allowNull: true },
            agent_type: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'exec' },
            manifest: { type: DataTypes.JSONB, allowNull: false },
            org_id: { type: DataTypes.UUID, allowNull: true },
            is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            deleted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            deleted_at: { type: DataTypes.BIGINT, allowNull: true },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        },
        {
            sequelize,
            schema: 'cliq',
            tableName: 'agent_catalog',
            timestamps: false,
            underscored: true,
        },
    );
}
