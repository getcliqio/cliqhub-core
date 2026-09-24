import { DataTypes, Model, type Sequelize } from 'sequelize';

export class RealmInvite extends Model {
    declare id: string;
    declare realm_id: string;
    declare email: string;
    declare invited_by: string;
    declare token_hash: string;
    declare role: 'admin' | 'operator' | 'member';
    declare status: 'pending' | 'accepted' | 'revoked';
    declare created_at: Date;
    declare expires_at: Date;
    declare accepted_at: Date | null;
    declare accepted_user_id: string | null;
}

export function init_realm_invite_model(sequelize: Sequelize): typeof RealmInvite {
    RealmInvite.init({
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        realm_id: { type: DataTypes.TEXT, allowNull: false },
        email: { type: DataTypes.TEXT, allowNull: false },
        invited_by: { type: DataTypes.UUID, allowNull: false },
        token_hash: { type: DataTypes.TEXT, allowNull: false, unique: true },
        role: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'member' },
        status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'pending' },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        expires_at: { type: DataTypes.DATE, allowNull: false },
        accepted_at: { type: DataTypes.DATE, allowNull: true },
        accepted_user_id: { type: DataTypes.UUID, allowNull: true },
    }, {
        sequelize,
        tableName: 'realm_invites',
        updatedAt: false,
        createdAt: 'created_at',
    });
    return RealmInvite;
}
