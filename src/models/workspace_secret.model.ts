import { DataTypes, type Sequelize } from 'sequelize';
import { ModelConfig } from '../lib/model_options.js';
import { BaseModel } from './base_model.js';

/**
 * Encrypted secret stored within a workspace context.
 *
 * Secrets are key/value pairs scoped to a `workspace_id`. The `value` field
 * holds the ciphertext; encryption/decryption is handled at the service layer.
 * Used to pass API keys and credentials into agent runs without embedding
 * them in the workflow manifest.
 */
export class WorkspaceSecret extends BaseModel {
    declare id: string;
    declare workspace_id: string;
    declare key: string;
    declare value: string;
    declare updated_at: number;

    static register(sequelize: Sequelize): void {
        WorkspaceSecret.init({
            id: { type: DataTypes.TEXT, primaryKey: true },
            workspace_id: { type: DataTypes.TEXT, allowNull: false },
            key: { type: DataTypes.TEXT, allowNull: false },
            value: { type: DataTypes.TEXT, allowNull: false },
            updated_at: { type: DataTypes.BIGINT, allowNull: false },
        }, ModelConfig.table_options(sequelize, 'workspace_secrets', {
            indexes: [{ unique: true, fields: ['workspace_id', 'key'] }],
        }));
    }
}

export type WorkspaceSecretAttributes = {
    id: string;
    workspace_id: string;
    key: string;
    value: string;
    updated_at: number;
};
