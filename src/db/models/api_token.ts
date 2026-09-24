import { DataTypes, Model, type Sequelize } from 'sequelize';

export type Token_type = 'user' | 'realm' | 'daemon';

export interface TokenPermissions {
    domains?: {
        orgs?: Array<string | '*'> | '*';
        scopes?: Array<string | '*'> | '*';
        realms?: Array<string | '*'> | '*';
    };
    access?: Partial<Record<string, Array<'read' | 'write' | 'admin'>>> | string;
    /** @deprecated */
    org_ids?: string[];
}

/**
 * Unified Hub token row (`public.tokens`).
 * `type=user` → `cliq_tok_…` (bcrypt hash + prefix lookup).
 * `type=realm` → `cliq_dt_…` (sha256 hex hash).
 */
export class ApiToken extends Model {
    declare id: string;
    declare type: Token_type;
    declare user_id: string;
    declare token_hash: string;
    declare token_prefix: string | null;
    declare name: string;
    declare permissions: TokenPermissions;
    /**
     * API capability scopes (JIRA plugin slice 1.6). Empty array =
     * legacy full-power token. Non-empty = least-privilege: enforced
     * by `require_token_scope` middleware on Forge-facing routes.
     * Values are opaque strings (e.g. `dispatch`, `read:realms`).
     */
    declare scopes: string[];
    declare created_at: Date;
    declare last_used_at: Date | null;
    declare revoked_at: Date | null;
}

export function init_api_token_model(sequelize: Sequelize): typeof ApiToken {
    ApiToken.init({
        id: { type: DataTypes.TEXT, primaryKey: true },
        type: { type: DataTypes.TEXT, allowNull: false },
        user_id: { type: DataTypes.UUID, allowNull: false },
        token_hash: { type: DataTypes.TEXT, allowNull: false },
        token_prefix: { type: DataTypes.TEXT, allowNull: true },
        name: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        permissions: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
        scopes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
        last_used_at: { type: DataTypes.DATE, allowNull: true },
        revoked_at: { type: DataTypes.DATE, allowNull: true },
    }, { sequelize, tableName: 'tokens' });
    return ApiToken;
}
