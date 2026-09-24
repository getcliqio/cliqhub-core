import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { DataTypes } from 'sequelize';

export type Realm_member_type = 'user' | 'daemon' | 'group';
export type Realm_member_role = 'admin' | 'operator' | 'member';

export interface RealmMemberAttributes {
    id: string;
    realm_id: string;
    member_type: Realm_member_type;
    member_id: string;
    role: Realm_member_role;
    created_at: number;
}

export type RealmMemberModel = Model<RealmMemberAttributes> & RealmMemberAttributes;

/** Set by `init_realm_member` — uses the store Sequelize's Model class. */
export let RealmMember: ModelStatic<RealmMemberModel>;

export function init_realm_member(sequelize: Sequelize): void {
    RealmMember = sequelize.define(
        'RealmMember',
        {
            id: { type: DataTypes.TEXT, primaryKey: true },
            realm_id: { type: DataTypes.TEXT, allowNull: false },
            member_type: { type: DataTypes.TEXT, allowNull: false },
            member_id: { type: DataTypes.TEXT, allowNull: false },
            role: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'operator' },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
        },
        {
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
        },
    ) as ModelStatic<RealmMemberModel>;
}
