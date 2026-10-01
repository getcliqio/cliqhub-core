import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export class RealmDispatchKey extends BaseModel {
    declare realm_id: string;
    declare public_key_pem: string;
    declare private_key_pem: string;
    declare created_at: number;
    declare rotated_at: number;

    static register(sequelize: Sequelize): void {
        RealmDispatchKey.init({
            realm_id: { type: DataTypes.TEXT, primaryKey: true },
            public_key_pem: { type: DataTypes.TEXT, allowNull: false },
            private_key_pem: { type: DataTypes.TEXT, allowNull: false },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            rotated_at: { type: DataTypes.BIGINT, allowNull: false },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'realm_dispatch_keys',
            timestamps: false,
        });
    }
}

/** @deprecated Use RealmDispatchKey directly */
export type RealmDispatchKeyModel = RealmDispatchKey;

export type RealmDispatchKeyAttributes = {
    realm_id: string;
    public_key_pem: string;
    private_key_pem: string;
    created_at: number;
    rotated_at: number;
};
