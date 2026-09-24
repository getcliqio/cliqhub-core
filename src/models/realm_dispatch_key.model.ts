import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export interface RealmDispatchKeyAttributes {
    realm_id: string;
    public_key_pem: string;
    private_key_pem: string;
    created_at: number;
    rotated_at: number;
}

export type RealmDispatchKeyModel = Model<RealmDispatchKeyAttributes> & RealmDispatchKeyAttributes;

export let RealmDispatchKey: ModelStatic<RealmDispatchKeyModel>;

export function init_realm_dispatch_key(sequelize: Sequelize): void {
    RealmDispatchKey = sequelize.define(
        'RealmDispatchKey',
        {
            realm_id: { type: DataTypes.TEXT, primaryKey: true },
            public_key_pem: { type: DataTypes.TEXT, allowNull: false },
            private_key_pem: { type: DataTypes.TEXT, allowNull: false },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            rotated_at: { type: DataTypes.BIGINT, allowNull: false },
        },
        {
            schema: 'cliq',
            tableName: 'realm_dispatch_keys',
            timestamps: false,
        },
    ) as ModelStatic<RealmDispatchKeyModel>;
}
