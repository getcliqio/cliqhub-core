import { DataTypes, Model, type Sequelize } from 'sequelize';

export class Setting extends Model {
    declare key: string;
    declare value: string;
    declare updated_at: Date;
}

export function init_setting_model(sequelize: Sequelize): typeof Setting {
    Setting.init({
        key: { type: DataTypes.TEXT, primaryKey: true },
        value: { type: DataTypes.TEXT, allowNull: false },
        updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, { sequelize, tableName: 'settings' });
    return Setting;
}
