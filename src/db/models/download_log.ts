import { DataTypes, Model, type Sequelize } from 'sequelize';

export class DownloadLog extends Model {
    declare team_id: string;
    declare download_key: string;
    declare date: string;
}

export function init_download_log_model(sequelize: Sequelize): typeof DownloadLog {
    DownloadLog.init({
        team_id: { type: DataTypes.UUID, allowNull: false },
        download_key: { type: DataTypes.TEXT, allowNull: false },
        date: { type: DataTypes.TEXT, allowNull: false },
    }, {
        sequelize, tableName: 'download_log',
        indexes: [{ unique: true, fields: ['team_id', 'download_key', 'date'] }],
    });
    DownloadLog.removeAttribute('id');
    return DownloadLog;
}
