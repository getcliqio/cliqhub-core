import { DataTypes, Model, type Sequelize } from 'sequelize';

export class AccountInvite extends Model {
    declare id: string;
    declare org_id: string;
    declare email: string;
    declare invited_by: string;
    declare token_hash: string;
    declare role: 'admin' | 'member';
    declare status: 'pending' | 'accepted' | 'revoked';
    declare created_at: Date;
    declare expires_at: Date;
    declare accepted_at: Date | null;
    declare accepted_user_id: string | null;
}

export function init_account_invite_model(sequelize: Sequelize): typeof AccountInvite {
    AccountInvite.init({
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        org_id: { type: DataTypes.UUID, allowNull: false },
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
        tableName: 'account_invites',
        updatedAt: false,
        createdAt: 'created_at',
    });
    return AccountInvite;
}
