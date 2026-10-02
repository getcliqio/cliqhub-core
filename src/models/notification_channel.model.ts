import { DataTypes, Op, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

export class NotificationChannel extends BaseModel {
    declare id: string;
    /** Owning realm, or null for org-level channels. */
    declare realm_id: string | null;
    /** Owning org — set for org-level channels (realm_id IS NULL). */
    declare org_id: string | null;
    /** Owning user — set for personal channels, null for shared channels. */
    declare user_id: string | null;
    declare name: string;
    /**
     * Optional HMAC shared secret for webhook channels. Populated on
     * create/rotate. Deliverer reads this in preference to destination
     * config. Subsequent reads via get_channel show only the '***' mask.
     */
    declare secret: string | null;
    declare enabled: number;
    declare created_at: number;
    declare updated_at: number;
    /** Set on channels the system seeds (e.g. `org.email`); unique per org. */
    declare system_key: string | null;
    /** A locked channel cannot be changed or removed (409 `locked`). */
    declare locked: boolean;
    /** Why the channel is locked, shown next to the lock. */
    declare lock_reason: string | null;

    static register(sequelize: Sequelize): void {
        NotificationChannel.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            realm_id: { type: DataTypes.TEXT, allowNull: true },
            org_id: { type: DataTypes.UUID, allowNull: true },
            user_id: { type: DataTypes.UUID, allowNull: true },
            name: { type: DataTypes.TEXT, allowNull: false },
            secret: { type: DataTypes.TEXT, allowNull: true },
            enabled: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
            system_key: { type: DataTypes.TEXT, allowNull: true },
            locked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            lock_reason: { type: DataTypes.TEXT, allowNull: true },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'notification_channels',
            timestamps: false,
            indexes: [
                { fields: ['realm_id'] },
                { fields: ['org_id'], name: 'notification_channels_org_id_idx' },
                { unique: true, fields: ['realm_id', 'name'], where: { realm_id: { [Op.ne]: null } } },
                { unique: true, fields: ['org_id', 'name'], where: { realm_id: null } },
            ],
        });
    }
}

export type NotificationChannelAttributes = {
    id: string;
    realm_id: string | null;
    org_id: string | null;
    user_id: string | null;
    name: string;
    secret: string | null;
    enabled: number;
    created_at: number;
    updated_at: number;
};
