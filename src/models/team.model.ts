import { DataTypes, type Sequelize } from 'sequelize';
import { BaseModel } from './base_model.js';

/**
 * Published agent team in the registry.
 *
 * A team is a versioned, shareable workflow. `scope` is the owner's slug
 * (`org/scope` or personal), `name` is unique within a scope. `visibility`
 * controls discoverability: `public` (registry), `private` (scope members
 * only), or `draft` (owner only). `listed` controls appearance in the public
 * browse feed independent of visibility.
 */
export class Team extends BaseModel {
    declare id: string;
    declare name: string;
    declare scope: string | null;
    declare scope_type: 'user' | 'org' | null;
    declare description: string;
    declare author_id: string | null;
    declare license: string;
    declare visibility: 'public' | 'private' | 'draft';
    declare listed: number;
    declare created_at: Date;
    declare updated_at: Date;
    declare install_count: number;
    /** The team this one was forked from, or null. */
    declare forked_from_team_id: string | null;
    /** The version of that team the fork started from, or null. */
    declare forked_from_version: string | null;

    static register(sequelize: Sequelize): void {
        Team.init({
            id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
            name: { type: DataTypes.TEXT, allowNull: false },
            scope: { type: DataTypes.TEXT, allowNull: true },
            scope_type: { type: DataTypes.TEXT, allowNull: true },
            description: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
            author_id: { type: DataTypes.UUID, allowNull: true },
            license: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'MIT' },
            visibility: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'public' },
            listed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
            created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
            install_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            forked_from_team_id: { type: DataTypes.UUID, allowNull: true },
            forked_from_version: { type: DataTypes.TEXT, allowNull: true },
        }, {
            sequelize, tableName: 'teams', schema: 'cliq',
            indexes: [{ unique: true, fields: ['name', 'scope'] }],
        });
    }
}
