import { DataTypes, Model, type Sequelize } from 'sequelize';

export class ScopeMember extends Model {
    declare scope_id: string;
    declare user_id: string;
}

export function init_scope_member_model(sequelize: Sequelize): typeof ScopeMember {
    ScopeMember.init({
        scope_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
        user_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
    }, { sequelize, tableName: 'scope_members' });
    return ScopeMember;
}
