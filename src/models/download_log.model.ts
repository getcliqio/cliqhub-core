import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * Daily download counter for a team package.
 *
 * Composite PK of `(team_id, download_key, date)`. `download_key` is a
 * stable hash of the caller identity (org + scope). Rows are upserted on
 * each download so counts remain idempotent for the same requester on the
 * same day. No surrogate PK — `id` attribute is removed after init.
 */
export class DownloadLog extends BaseModel {
    declare team_id: string;
    declare download_key: string;
    declare date: string;

    static register(sequelize: Sequelize): void {
        DownloadLog.init({
            team_id: { type: DataTypes.UUID, allowNull: false },
            download_key: { type: DataTypes.TEXT, allowNull: false },
            date: { type: DataTypes.TEXT, allowNull: false },
        }, {
            sequelize, tableName: 'download_log', schema: 'cliq',
            indexes: [{ unique: true, fields: ['team_id', 'download_key', 'date'] }],
        });
        DownloadLog.removeAttribute('id');
    }
}
