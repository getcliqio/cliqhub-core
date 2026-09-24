import { DataTypes, Model, type Sequelize } from 'sequelize';

export class Org extends Model {
    declare id: string;
    declare slug: string;
    declare display_name: string;
    declare created_at: Date;
    declare default_scope_id: string | null;
    declare mesh_active_provider_id: string | null;
    declare mesh_providers: Record<string, Record<string, unknown>>;
    declare mesh_auto_enable_a2a_on_realm_create: boolean;
}

export function init_org_model(sequelize: Sequelize): typeof Org {
    Org.init({
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        slug: { type: DataTypes.TEXT, unique: true, allowNull: false },
        display_name: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        default_scope_id: { type: DataTypes.UUID, allowNull: true },
        mesh_active_provider_id: { type: DataTypes.TEXT, allowNull: true, defaultValue: null },
        mesh_providers: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        mesh_auto_enable_a2a_on_realm_create: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        },
    }, { sequelize, tableName: 'orgs' });
    return Org;
}
