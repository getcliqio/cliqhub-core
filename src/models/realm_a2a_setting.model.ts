import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export type Realm_mesh_provider_mode = 'inherit' | 'override' | 'none';

export interface Realm_a2a_setting_attributes {
    realm_id: string;
    a2a_enabled: boolean;
    /** SHA-256 hex of the realm A2A bearer; null until first rotate. */
    bearer_token_hash: string | null;
    /** First 16 hex chars of the hash for UI display (not secret). */
    bearer_token_prefix: string | null;
    /** inherit account | override with realm active_provider_id | none */
    mesh_provider_mode: Realm_mesh_provider_mode;
    /** Used when mesh_provider_mode === 'override' */
    active_provider_id: string | null;
    /** Per-provider settings blobs keyed by provider id */
    providers: Record<string, Record<string, unknown>>;
    /** Last known mesh health / status from adapter */
    mesh_status: Record<string, unknown> | null;
    created_at: number;
    updated_at: number;
}

export type Realm_a2a_setting_model =
    Model<Realm_a2a_setting_attributes> & Realm_a2a_setting_attributes;

export let RealmA2aSetting: ModelStatic<Realm_a2a_setting_model>;

export function init_realm_a2a_setting(sequelize: Sequelize): void {
    RealmA2aSetting = sequelize.define(
        'RealmA2aSetting',
        {
            realm_id: { type: DataTypes.TEXT, primaryKey: true },
            a2a_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            bearer_token_hash: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
            bearer_token_prefix: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
            mesh_provider_mode: {
                type: DataTypes.TEXT,
                allowNull: false,
                defaultValue: 'inherit',
            },
            active_provider_id: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
            providers: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            mesh_status: { type: DataTypes.JSONB, allowNull: true, defaultValue: null },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        },
        {
            schema: 'cliq',
            tableName: 'realm_a2a_settings',
            timestamps: false,
        },
    ) as ModelStatic<Realm_a2a_setting_model>;
}
