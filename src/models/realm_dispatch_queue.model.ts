import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

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

export class RealmDispatchQueue extends BaseModel {
    declare id: string;
    declare realm_id: string;
    declare kind: Realm_dispatch_kind;
    declare payload: Record<string, unknown>;
    declare priority: number;
    declare status: Realm_dispatch_status;
    declare claimed_by: string | null;
    declare claimed_at: number | null;
    declare run_id: string | null;
    declare results: unknown[] | null;
    declare submitted_by: string;
    declare submitted_at: number;
    declare error: string | null;
    declare created_at: number;
    declare updated_at: number;

    static register(sequelize: Sequelize): void {
        RealmDispatchQueue.init({
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
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'realm_dispatch_queue',
            timestamps: false,
        });
    }
}

/** @deprecated Use RealmDispatchQueue directly */
export type Realm_dispatch_queue_model = RealmDispatchQueue;

export type Realm_dispatch_queue_attributes = {
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
};
