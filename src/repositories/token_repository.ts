import { randomUUID } from 'node:crypto';
import { ApiToken } from '../db/models/index.js';
import { fn, Op } from 'sequelize';
import type { TokenPermissions, Token_type } from '../db/models/api_token.js';

export class TokenRepository {
    async find_by_prefix(prefix: string) {
        return ApiToken.findOne({
            where: {
                token_prefix: prefix,
                revoked_at: { [Op.is]: null },
            },
            attributes: ['id', 'type', 'user_id', 'token_hash', 'permissions', 'scopes', 'name'],
            raw: true,
        });
    }

    async find_by_hash(token_hash: string) {
        return ApiToken.findOne({
            where: {
                token_hash,
                revoked_at: { [Op.is]: null },
            },
            attributes: ['id', 'type', 'user_id', 'token_hash', 'permissions', 'scopes', 'name'],
            raw: true,
        });
    }

    async update_last_used(id: string): Promise<void> {
        await ApiToken.update({ last_used_at: fn('NOW') }, { where: { id } });
    }

    async create(input: {
        type: Token_type;
        user_id: string;
        token_hash: string;
        token_prefix: string | null;
        name: string;
        permissions?: TokenPermissions;
        scopes?: string[];
        id?: string;
    }): Promise<ApiToken> {
        return ApiToken.create({
            id: input.id ?? randomUUID(),
            type: input.type,
            user_id: input.user_id,
            token_hash: input.token_hash,
            token_prefix: input.token_prefix,
            name: input.name,
            permissions: input.permissions ?? {},
            scopes: input.scopes ?? [],
            revoked_at: null,
        });
    }

    async find_by_id(id: string) {
        return ApiToken.findByPk(id, {
            attributes: [
                'id', 'type', 'user_id', 'name', 'permissions', 'scopes',
                'created_at', 'last_used_at', 'revoked_at',
            ],
            raw: true,
        });
    }

    async list_by_user_id(
        user_id: string,
        opts: { type?: Token_type; query?: string; limit?: number; offset?: number } = {},
    ) {
        const where: Record<string, unknown> = {
            user_id,
            revoked_at: { [Op.is]: null },
        };
        if (opts.type) where.type = opts.type;
        const query = opts.query?.trim();
        if (query) {
            const pattern = `%${query.replace(/[%_]/g, '\\$&')}%`;
            where.name = { [Op.iLike]: pattern };
        }

        return ApiToken.findAll({
            where,
            attributes: [
                'id', 'type', 'name', 'permissions', 'scopes',
                'created_at', 'last_used_at', 'revoked_at',
            ],
            order: [['created_at', 'DESC']],
            ...(opts.limit ? { limit: opts.limit } : {}),
            ...(opts.offset ? { offset: opts.offset } : {}),
            raw: true,
        });
    }

    /**
     * Enroll tokens (`realm` + auto-enrolled `daemon`) whose grant lists this
     * realm id. Does not match `realms: '*'` — those are site-wide and must
     * not be revoked when a single realm is deleted.
     */
    async list_daemon_tokens_for_realm(realm_id: string, user_id?: string) {
        const where: Record<string, unknown> = {
            type: { [Op.in]: ['realm', 'daemon'] },
        };
        if (user_id != null) where.user_id = user_id;

        const rows = await ApiToken.findAll({
            where,
            attributes: [
                'id', 'type', 'user_id', 'name', 'permissions',
                'created_at', 'last_used_at', 'revoked_at',
            ],
            order: [['created_at', 'DESC']],
            raw: true,
        });

        return rows.filter((row) => {
            if (row.revoked_at) return false;
            const realms = (row.permissions as TokenPermissions | undefined)?.domains?.realms;
            if (realms === '*') return false;
            return Array.isArray(realms) && realms.includes(realm_id);
        });
    }

    async count_by_user_id(
        user_id: string,
        opts: { type?: Token_type; query?: string } = {},
    ): Promise<number> {
        const where: Record<string, unknown> = {
            user_id,
            revoked_at: { [Op.is]: null },
        };
        if (opts.type) where.type = opts.type;
        const query = opts.query?.trim();
        if (query) {
            const pattern = `%${query.replace(/[%_]/g, '\\$&')}%`;
            where.name = { [Op.iLike]: pattern };
        }
        return ApiToken.count({ where });
    }

    async soft_revoke(id: string, user_id?: string): Promise<number> {
        const where: Record<string, unknown> = { id, revoked_at: { [Op.is]: null } };
        if (user_id != null) where.user_id = user_id;
        const [count] = await ApiToken.update(
            { revoked_at: new Date() },
            { where },
        );
        return count;
    }

    /** Soft-revoke by id only (no user_id filter) — session logout / revoke_session_token. */
    async soft_revoke_by_id(id: string): Promise<number> {
        return this.soft_revoke(id);
    }

    /** @deprecated prefer soft_revoke — kept for admin hard delete paths */
    async delete_by_id_and_user(id: string, user_id: string): Promise<number> {
        return this.soft_revoke(id, user_id);
    }

    async update_hash(id: string, token_hash: string, token_prefix: string | null): Promise<void> {
        await ApiToken.update({ token_hash, token_prefix }, { where: { id } });
    }

    async update_permissions(id: string, permissions: TokenPermissions): Promise<void> {
        await ApiToken.update({ permissions }, { where: { id } });
    }

    async revoke_all_for_realm(realm_id: string): Promise<void> {
        const rows = await this.list_daemon_tokens_for_realm(realm_id);
        for (const row of rows) {
            await this.soft_revoke(row.id);
        }
    }

    /**
     * Revoke auto-enrolled bootstrap tokens for a user (logout cleanup).
     * Covers legacy `type=daemon` rows and current `type=realm` mints.
     */
    async revoke_auto_enrolled(user_id: string): Promise<number> {
        const rows = await ApiToken.findAll({
            where: {
                user_id,
                type: { [Op.in]: ['daemon', 'realm'] },
                revoked_at: { [Op.is]: null },
            },
        });

        let count = 0;
        for (const row of rows) {
            const perms = row.permissions as TokenPermissions | undefined;
            if ((perms as Record<string, unknown>)?.auto_enrolled !== true) continue;
            row.revoked_at = new Date();
            await row.save();
            count++;
        }
        return count;
    }
}
