import { randomUUID } from 'node:crypto';
import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * A person's own choice for one event (PLAN-notification-layers D) — the person layer, which wins over the realm
 * and the org for that person. `scope`: `my_runs` — about runs they started; `all` — what reaches them from their
 * org and realms. `state`: `on` / `off`. No row = follow the realm, then the org.
 */
export class NotificationPersonSetting extends BaseModel {
    declare id: string;
    declare user_id: string;
    declare scope: 'my_runs' | 'all';
    declare event: string;
    declare state: 'on' | 'off';
    declare created_at: number;
    declare updated_at: number;

    static register(sequelize: Sequelize): void {
        NotificationPersonSetting.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => randomUUID() },
            user_id: { type: DataTypes.TEXT, allowNull: false },
            scope: { type: DataTypes.TEXT, allowNull: false },
            event: { type: DataTypes.TEXT, allowNull: false },
            state: { type: DataTypes.TEXT, allowNull: false },
            created_at: { type: DataTypes.BIGINT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        }, {
            sequelize,
            schema: 'cliq',
            tableName: 'notification_person_settings',
            timestamps: false,
            indexes: [
                { unique: true, fields: ['user_id', 'scope', 'event'] },
                { fields: ['scope', 'event', 'state'] },
            ],
        });
    }
}
