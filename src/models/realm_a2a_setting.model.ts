import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export type Realm_mesh_provider_mode = 'inherit' | 'override' | 'none';

export class RealmA2aSetting extends BaseModel {
    declare realm_id: string;
    declare a2a_enabled: boolean;
    /** SHA-256 hex of the realm A2A bearer; null until first rotate. */
    declare bearer_token_hash: string | null;
    /** First 16 hex chars of the hash for UI display (not secret). */
    declare bearer_token_prefix: string | null;
    /** inherit account | override with realm active_provider_id | none */
    declare mesh_provider_mode: Realm_mesh_provider_mode;
    /** Used when mesh_provider_mode === 'override' */
    declare active_provider_id: string | null;
    /** Per-provider settings blobs keyed by provider id */
    declare providers: Record<string, Record<string, unknown>>;
    /** Last known mesh health / status from adapter */
    declare mesh_status: Record<string, unknown> | null;
    declare created_at: number;
    declare updated_at: number;

    static register(sequelize: Sequelize): void {
        RealmA2aSetting.init({
            realm_id: { type: DataTypes.TEXT, primaryKey: true },
            a2a_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            bearer_token_hash: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
            bearer_token_prefix: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
            mesh_provider_mode: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'inherit' },
            active_provider_id: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
            providers: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            mesh_status: { type: DataTypes.JSONB, allowNull: true, defaultValue: null },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'realm_a2a_settings',
            timestamps: false,
        });
    }
}

export type Realm_a2a_setting_attributes = {
    realm_id: string;
    a2a_enabled: boolean;
    bearer_token_hash: string | null;
    bearer_token_prefix: string | null;
    mesh_provider_mode: Realm_mesh_provider_mode;
    active_provider_id: string | null;
    providers: Record<string, Record<string, unknown>>;
    mesh_status: Record<string, unknown> | null;
    created_at: number;
    updated_at: number;
};
