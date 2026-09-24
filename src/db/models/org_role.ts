/**
 * OrgRole — customizable permission bundles per org.
 *
 * Every org gets four default roles on creation (owner, admin, operator,
 * member). Admins can edit permissions on non-system roles and create
 * custom roles by forking existing ones ("Save As New Role").
 *
 * The `owner` role is a system role with implicit all-permissions;
 * its permissions array is empty by convention (checked by is_system).
 */

import { DataTypes, Model, type Sequelize } from 'sequelize';

export class OrgRole extends Model {
    declare id: string;
    declare org_id: string;
    declare slug: string;
    declare name: string;
    declare permissions: string[];
    /** True for the `owner` role — cannot be edited or deleted. */
    declare is_system: boolean;
    /** True for the four shipped roles (owner, admin, operator, member). */
    declare is_default: boolean;
    declare created_at: Date;
}

export function init_org_role_model(sequelize: Sequelize): typeof OrgRole {
    OrgRole.init({
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        org_id: { type: DataTypes.UUID, allowNull: false },
        slug: { type: DataTypes.TEXT, allowNull: false },
        name: { type: DataTypes.TEXT, allowNull: false },
        permissions: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
        is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        sequelize,
        tableName: 'org_roles',
        indexes: [
            { unique: true, fields: ['org_id', 'slug'], name: 'org_roles_org_slug_uidx' },
        ],
    });
    return OrgRole;
}
