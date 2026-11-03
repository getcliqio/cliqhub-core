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
 * A child of a realm team (PLAN-team-bundle S4.2): Core writes a row only when
 * the hub installs a realm team onto a daemon, and the row's id is what it sends
 * the daemon (`/v1/install` `team_id`, cliqd's `hub_team_id`); Core never takes
 * an id from a daemon. A live row has its `realm_team_id` (a CHECK enforces it),
 * the catalog `team_id` and the installed `version_id`.
 *
 * One row per (daemon, catalog team) for the life of that install: an uninstall
 * sets `uninstalled_at` instead of deleting, so runs keep their team and a
 * reinstall gets the same id back. When its realm team goes, `realm_team_id`
 * becomes null and a trigger marks the row uninstalled. The default scope hides
 * uninstalled rows; reads that must see them (run labels, reactivation) use
 * `DaemonTeam.unscoped()`.
 */
export class DaemonTeam extends BaseModel {
    declare id: string;
    declare daemon_id: string | null;
    declare scope_id: string;
    declare slug: string;
    /** The catalog team (`teams.id`). */
    declare team_id: string | null;
    /** The realm team this install belongs to; null only once uninstalled. */
    declare realm_team_id: string | null;
    /** The catalog version installed on this daemon (`team_versions.id`). */
    declare version_id: string | null;
    declare version: string | null;
    /** Who placed this installation: `'cli'` or `'hub'`. */
    declare origin: string | null;
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
            team_id: { type: DataTypes.UUID, allowNull: true },
            realm_team_id: { type: DataTypes.UUID, allowNull: true },
            version_id: { type: DataTypes.UUID, allowNull: true },
            version: { type: DataTypes.TEXT },
            origin: { type: DataTypes.TEXT, allowNull: true },
            description: { type: DataTypes.TEXT },
            manifest: { type: DataTypes.TEXT, allowNull: false },
            dockerfile: { type: DataTypes.TEXT },
            dependencies: { type: DataTypes.TEXT },
            uninstalled_at: { type: DataTypes.BIGINT, allowNull: true },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        }, ModelConfig.table_options(sequelize, 'daemon_teams', {
            // Indexes live in control_plane_schema_migrations (one live row per daemon and catalog team).
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
    /** Who placed this installation: `'cli'` or `'hub'`. */
    origin: string | null;
    description: string | null;
    manifest: string;
    dockerfile: string | null;
    dependencies: string | null;
    uninstalled_at: number | null;
    created_at: number;
    updated_at: number;
};
