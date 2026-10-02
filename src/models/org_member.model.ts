import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/** `pending` while the person's invite is open, `active` once they joined. */
export type MembershipStatus = 'pending' | 'active';

/**
 * A user's membership of an org. Removed memberships are soft-deleted
 * (`deleted_at`) so member lists can show former members; the primary key is
 * (org_id, user_id), so inviting the same person again revives this row.
 */
export class OrgMember extends BaseModel {
    declare org_id: string;
    declare user_id: string;
    /** @deprecated Use role_id instead. Kept for backward compat during migration. */
    declare role: string;
    /** FK into org_roles — the member's assigned role. */
    declare role_id: string | null;
    declare status: MembershipStatus;
    declare deleted_at: Date | null;
    declare invited_at: Date | null;
    declare joined_at: Date | null;

    static register(sequelize: Sequelize): void {
        OrgMember.init({
            org_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
            user_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
            role: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'member' },
            role_id: { type: DataTypes.UUID, allowNull: true },
            status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'active' },
            deleted_at: { type: DataTypes.DATE, allowNull: true },
            invited_at: { type: DataTypes.DATE, allowNull: true },
            joined_at: { type: DataTypes.DATE, allowNull: true },
        }, { sequelize, tableName: 'org_members', schema: 'cliq' });
    }
}
