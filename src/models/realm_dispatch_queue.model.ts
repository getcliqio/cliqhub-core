import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export type Realm_dispatch_kind = 'run' | 'install' | 'uninstall';

export type Realm_dispatch_status =
    | 'queued'
    | 'offered'
    | 'claimed'
    | 'running'
    | 'dispatching'
    | 'completed'
    | 'partial'
    | 'failed'
    | 'cancelled';

export interface Realm_dispatch_queue_attributes {
    id: string;
    realm_id: string;
    kind: Realm_dispatch_kind;
    payload: Record<string, unknown>;
    priority: number;
    status: Realm_dispatch_status;
    claimed_by: string | null;
    claimed_at: number | null;
    run_id: string | null;
    results: unknown[] | null;
    submitted_by: string;
    submitted_at: number;
    error: string | null;
    created_at: number;
    updated_at: number;
}

export type Realm_dispatch_queue_model =
    Model<Realm_dispatch_queue_attributes> & Realm_dispatch_queue_attributes;

/** Set by `init_realm_dispatch_queue` — uses the store Sequelize's Model class. */
export let RealmDispatchQueue: ModelStatic<Realm_dispatch_queue_model>;

export function init_realm_dispatch_queue(sequelize: Sequelize): void {
    RealmDispatchQueue = sequelize.define(
        'RealmDispatchQueue',
        {
            id: { type: DataTypes.TEXT, primaryKey: true },
            realm_id: { type: DataTypes.TEXT, allowNull: false },
            kind: { type: DataTypes.TEXT, allowNull: false },
            payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
            priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'queued' },
            claimed_by: { type: DataTypes.TEXT, allowNull: true },
            claimed_at: { type: DataTypes.BIGINT, allowNull: true },
            run_id: { type: DataTypes.TEXT, allowNull: true },
            results: { type: DataTypes.JSONB, allowNull: true },
            submitted_by: { type: DataTypes.TEXT, allowNull: false },
            submitted_at: { type: DataTypes.BIGINT, allowNull: false },
            error: { type: DataTypes.TEXT, allowNull: true },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        },
        {
            schema: 'cliq',
            tableName: 'realm_dispatch_queue',
            timestamps: false,
        },
    ) as ModelStatic<Realm_dispatch_queue_model>;
}
