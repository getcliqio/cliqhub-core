import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export type Realm_member_type = 'user' | 'daemon' | 'group';
export type Realm_member_role = 'admin' | 'operator' | 'member';

export class RealmMember extends BaseModel {
    declare id: string;
    declare realm_id: string;
    declare member_type: Realm_member_type;
    declare member_id: string;
    declare role: Realm_member_role;
    declare created_at: number;

    static register(sequelize: Sequelize): void {
        RealmMember.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            realm_id: { type: DataTypes.TEXT, allowNull: false },
            member_type: { type: DataTypes.TEXT, allowNull: false },
            member_id: { type: DataTypes.TEXT, allowNull: false },
            role: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'operator' },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'realm_members',
            timestamps: false,
            indexes: [
                {
                    unique: true,
                    fields: ['realm_id', 'member_type', 'member_id'],
                    name: 'realm_members_realm_type_id_uniq',
                },
            ],
        });
    }
}

/** @deprecated Use RealmMember directly */
export type RealmMemberModel = RealmMember;

export type RealmMemberAttributes = {
    id: string;
    realm_id: string;
    member_type: Realm_member_type;
    member_id: string;
    role: Realm_member_role;
    created_at: number;
};
