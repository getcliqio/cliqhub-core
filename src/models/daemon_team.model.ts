import { DataTypes, type Sequelize } from 'sequelize';
import { ModelConfig } from '../lib/model_options.js';
import { BaseModel } from './base_model.js';

/**
 * Daemon-local team snapshot — a copy of a team's manifest pinned to a
 * specific daemon for offline/local dispatch.
 *
 * When a realm installs a team, the hub writes a `DaemonTeam` row so the
 * daemon can execute the workflow without a round-trip to the registry. The
 * `manifest` and `dockerfile` fields mirror the team version at install time.
 *
 * One row per (daemon, scope, slug) for the life of that install slot: an
 * uninstall sets `uninstalled_at` instead of deleting, so runs keep their team
 * and a reinstall gets the same id back. The default scope hides uninstalled
 * rows; reads that must see them (run labels, reactivation, sync) use
 * `DaemonTeam.unscoped()`.
 */
export class DaemonTeam extends BaseModel {
    declare id: string;
    declare daemon_id: string | null;
    declare scope_id: string;
    declare slug: string;
    declare version: string | null;
    declare description: string | null;
    declare manifest: string;
    declare dockerfile: string | null;
    declare dependencies: string | null;
    /** When the team was removed from the daemon (ms); null while installed. */
    declare uninstalled_at: number | null;
    declare created_at: number;
    declare updated_at: number;

    static register(sequelize: Sequelize): void {
        DaemonTeam.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            daemon_id: { type: DataTypes.TEXT, allowNull: true },
            scope_id: { type: DataTypes.TEXT, allowNull: false },
            slug: { type: DataTypes.TEXT, allowNull: false },
            version: { type: DataTypes.TEXT },
            description: { type: DataTypes.TEXT },
            manifest: { type: DataTypes.TEXT, allowNull: false },
            dockerfile: { type: DataTypes.TEXT },
            dependencies: { type: DataTypes.TEXT },
            uninstalled_at: { type: DataTypes.BIGINT, allowNull: true },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        }, ModelConfig.table_options(sequelize, 'daemon_teams', {
            indexes: [{ unique: true, fields: ['daemon_id', 'scope_id', 'slug'] }],
            defaultScope: { where: { uninstalled_at: null } },
        }));
    }
}

export type DaemonTeamAttributes = {
    id: string;
    daemon_id: string | null;
    scope_id: string;
    slug: string;
    version: string | null;
    description: string | null;
    manifest: string;
    dockerfile: string | null;
    dependencies: string | null;
    uninstalled_at: number | null;
    created_at: number;
    updated_at: number;
};
