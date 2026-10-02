import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * `waiting_for_owner` until the owner accepts their invite, then `active`;
 * `deleted` once soft-deleted (`deleted_at` set).
 */
export type OrgStatus = 'active' | 'waiting_for_owner' | 'deleted';

/**
 * Organisation — the top-level multi-tenant container.
 *
 * An org owns scopes (namespaces), teams, and members. `slug` is globally
 * unique and forms the first segment of a team's fully-qualified name
 * (`org/scope/team`). `default_scope_id` points to the org's primary scope,
 * created automatically on org creation. Mesh fields control A2A provider
 * defaults for all realms inside the org.
 *
 * A deleted org keeps its row, id and slug (`deleted_at`); the slug stays taken.
 * `owner_id` mirrors the member holding the owner role.
 */
export class Org extends BaseModel {
    declare id: string;
    declare slug: string;
    declare display_name: string;
    declare created_at: Date;
    declare default_scope_id: string | null;
    declare mesh_active_provider_id: string | null;
    declare mesh_providers: Record<string, Record<string, unknown>>;
    declare mesh_auto_enable_a2a_on_realm_create: boolean;
    declare status: OrgStatus;
    declare deleted_at: Date | null;
    /** The owner (user id); kept in sync with the owner membership. Null while unknown. */
    declare owner_id: string | null;
    /** When the org first became active (owner accepted); null if it never did. */
    declare activated_at: Date | null;
    /** When the default notification channels and rules were seeded (OrgSeedService). */
    declare notifications_seeded_at: Date | null;
    /** Version of the default rules the org has (OrgSeedService.DEFAULTS_VERSION); null = seeded before versions (1). */
    declare notifications_seed_version: number | null;

    static register(sequelize: Sequelize): void {
        Org.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            slug: { type: DataTypes.TEXT, unique: true, allowNull: false },
            display_name: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            default_scope_id: { type: DataTypes.UUID, allowNull: true },
            mesh_active_provider_id: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
            mesh_providers: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            mesh_auto_enable_a2a_on_realm_create: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
            status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'active' },
            deleted_at: { type: DataTypes.DATE, allowNull: true },
            owner_id: { type: DataTypes.UUID, allowNull: true },
            activated_at: { type: DataTypes.DATE, allowNull: true },
            notifications_seeded_at: { type: DataTypes.DATE, allowNull: true },
            notifications_seed_version: { type: DataTypes.INTEGER, allowNull: true },
        }, { sequelize, tableName: 'orgs', schema: 'cliq' });
    }
}
