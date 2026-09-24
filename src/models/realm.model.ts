import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface TeamListEntry {
    scope: string;
    slug: string;
}

export interface RealmAttributes {
    id: string;
    slug: string;
    name: string;
    /** Account that owns this realm (billing / delete authority). */
    owner_user_id: string;
    created_by: string;
    /** Owning org — all realm data lives within this org boundary. */
    org_id: string;
    /** Declarative set of teams auto-installed on realm daemons. */
    team_list: TeamListEntry[];
    a2a_enabled: boolean;
    a2a_bearer_token_hash: string | null;
    a2a_bearer_token_prefix: string | null;
    mesh_provider_mode: 'inherit' | 'override' | 'none';
    mesh_active_provider_id: string | null;
    mesh_providers: Record<string, Record<string, unknown>>;
    mesh_status: Record<string, unknown> | null;
    /** Soft-delete flag — true after realm.remove; filtered from list/get. */
    deleted: boolean;
    /** When soft-deleted; null while alive. */
    deleted_at: number | null;
    created_at: number;
    updated_at: number;
}

export type RealmCreationAttributes = Omit<
    RealmAttributes,
    | 'team_list'
    | 'deleted'
    | 'deleted_at'
    | 'org_id'
    | 'a2a_enabled'
    | 'a2a_bearer_token_hash'
    | 'a2a_bearer_token_prefix'
    | 'mesh_provider_mode'
    | 'mesh_active_provider_id'
    | 'mesh_providers'
    | 'mesh_status'
> & {
    team_list?: TeamListEntry[];
    deleted?: boolean;
    deleted_at?: number | null;
    org_id?: string;
    a2a_enabled?: boolean;
    a2a_bearer_token_hash?: string | null;
    a2a_bearer_token_prefix?: string | null;
    mesh_provider_mode?: 'inherit' | 'override' | 'none';
    mesh_active_provider_id?: string | null;
    mesh_providers?: Record<string, Record<string, unknown>>;
    mesh_status?: Record<string, unknown> | null;
};
export type RealmModel = Model<RealmAttributes, RealmCreationAttributes> & RealmAttributes;

/** Set by `init_realm` — uses the store Sequelize's Model class. */
export let Realm: ModelStatic<RealmModel>;

export function init_realm(sequelize: Sequelize): void {
    Realm = sequelize.define(
        'Realm',
        {
            id: { type: DataTypes.TEXT, primaryKey: true },
            slug: { type: DataTypes.TEXT, allowNull: false },
            name: { type: DataTypes.TEXT, allowNull: false },
            owner_user_id: { type: DataTypes.TEXT, allowNull: false },
            created_by: { type: DataTypes.TEXT, allowNull: false },
            org_id: { type: DataTypes.UUID, allowNull: false },
            team_list: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
            a2a_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            a2a_bearer_token_hash: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
            a2a_bearer_token_prefix: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
            mesh_provider_mode: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'inherit' },
            mesh_active_provider_id: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
            mesh_providers: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            mesh_status: { type: DataTypes.JSONB, allowNull: true, defaultValue: null },
            deleted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            deleted_at: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        },
        {
            schema: 'cliq',
            tableName: 'realms',
            timestamps: false,
            indexes: [
                { fields: ['owner_user_id'], name: 'realms_owner_user_id_idx' },
                { fields: ['deleted'], name: 'realms_deleted_idx' },
                { fields: ['org_id'], name: 'realms_org_id_idx' },
            ],
        },
    ) as ModelStatic<RealmModel>;
}
