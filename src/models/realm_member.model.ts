import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';
import type { MembershipStatus } from './org_member.model.js';

export type Realm_member_type = 'user' | 'daemon' | 'group';
export type Realm_member_role = 'admin' | 'operator' | 'member';

/**
 * Where a realm membership grants access: live (not soft-deleted) and `active`.
 * It is the model's default scope, so every read sees only these rows; writes
 * that must see pending or former memberships use `RealmMember.unscoped()`.
 */
const LIVE_REALM_MEMBER = { status: 'active', deleted_at: null } as const;

/**
 * A user's, daemon's or group's membership of a realm. A realm invite holds a
 * `pending` row until it is accepted; removed memberships are soft-deleted
 * (`deleted_at`), and the unique (realm, type, member) key means adding the
 * same member again revives the row.
 */
export class RealmMember extends BaseModel {
    declare id: string;
    declare realm_id: string;
    declare member_type: Realm_member_type;
    declare member_id: string;
    declare role: Realm_member_role;
    declare created_at: number;
    /** `pending` while a realm invite is open; `active` once joined. */
    declare status: MembershipStatus;
    /** Soft delete: set when the membership was removed. */
    declare deleted_at: Date | null;

    static register(sequelize: Sequelize): void {
        RealmMember.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            realm_id: { type: DataTypes.TEXT, allowNull: false },
            member_type: { type: DataTypes.TEXT, allowNull: false },
            member_id: { type: DataTypes.TEXT, allowNull: false },
            role: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'operator' },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'active' },
            deleted_at: { type: DataTypes.DATE, allowNull: true },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'realm_members',
            timestamps: false,
            defaultScope: { where: { ...LIVE_REALM_MEMBER } },
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
