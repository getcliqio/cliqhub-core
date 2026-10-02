import { User } from '../models/index.js';
import { Scope } from '../models/index.js';
import type { Transaction } from 'sequelize';
import type { UserVO, UserLoginRowVO } from '../schemas/user_types.js';
import { BaseRepository } from './base_repository.js';

const USER_ATTRS = ['id', 'username', 'display_name', 'email', 'role', 'suspended_at', 'suspended_reason', 'created_at', 'preferences'] as const;
const LOGIN_ATTRS = ['id', 'username', 'password_hash', 'role', 'suspended_at', 'status', 'deleted_at'] as const;

// Converts a Sequelize Date column (or null) into the ISO-8601 string form
// used throughout the VO/DTO contracts. Works whether the driver yields a
// real Date, a string, or null.
function date_to_iso(value: Date | string | null | undefined): string | null {
    if (value == null) {
        return null;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    return value;
}

// Required-Date variant — the column is non-nullable, so an absent value is a
// programming error rather than a normal outcome.
function required_date_to_iso(value: Date | string): string {
    if (value instanceof Date) {
        return value.toISOString();
    }
    return value;
}

interface RawUserRow {
    id: string;
    username: string;
    display_name: string;
    email: string;
    role: 'user' | 'admin';
    suspended_at: Date | string | null;
    suspended_reason: string;
    created_at: Date | string;
    preferences: Record<string, unknown>;
}

interface RawLoginRow {
    id: string;
    username: string;
    password_hash: string;
    role: 'user' | 'admin';
    suspended_at: Date | string | null;
    status: 'invited' | 'active' | 'suspended';
    deleted_at: Date | string | null;
}

/** A user's state as lists show it: `deleted` once soft-deleted, else `users.status`. */
export type UserListStatus = 'invited' | 'active' | 'suspended' | 'deleted';

/** {@link UserListStatus} of a user row. */
export function user_list_status(row: { status: string; deleted_at: Date | string | null }): UserListStatus {
    return row.deleted_at ? 'deleted' : row.status as UserListStatus;
}

function to_user_vo(row: RawUserRow): UserVO {
    return {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        email: row.email,
        role: row.role,
        suspended_at: date_to_iso(row.suspended_at),
        suspended_reason: row.suspended_reason,
        created_at: required_date_to_iso(row.created_at),
        preferences: row.preferences ?? {},
    };
}

function to_login_vo(row: RawLoginRow): UserLoginRowVO {
    return {
        id: row.id,
        username: row.username,
        password_hash: row.password_hash,
        role: row.role,
        suspended_at: date_to_iso(row.suspended_at),
        status: row.status,
        deleted_at: date_to_iso(row.deleted_at),
    };
}

export class UserRepository extends BaseRepository<User> {
    protected readonly model = User;

    /**
     * Returns a VO projection of a live user (null when unknown or
     * soft-deleted). Use `find_by_id` for the raw instance.
     */
    async find_profile_by_id(id: string): Promise<UserVO | null> {
        const row = await User.findOne({ where: { id, deleted_at: null }, attributes: [...USER_ATTRS], raw: true }) as unknown as RawUserRow | null;
        return row ? to_user_vo(row) : null;
    }

    /** The sign-in fields of a user by id (deleted or not), for the sign-in refusals. */
    async find_login_row_by_id(id: string): Promise<UserLoginRowVO | null> {
        const row = await User.findByPk(id, { attributes: [...LOGIN_ATTRS], raw: true }) as unknown as RawLoginRow | null;
        return row ? to_login_vo(row) : null;
    }

    async find_by_username(username: string): Promise<UserLoginRowVO | null> {
        const row = await User.findOne({ where: { username }, attributes: [...LOGIN_ATTRS], raw: true }) as unknown as RawLoginRow | null;
        return row ? to_login_vo(row) : null;
    }


    /** Finds the user holding `email`, deleted or not (`deleted_at` tells which). */
    async find_by_email(email: string, exclude_id?: string) {
        const attributes = ['id', 'username', 'status', 'deleted_at'];
        if (exclude_id != null) {
            const { Op } = await import('sequelize');
            return User.findOne({
                where: { email, id: { [Op.ne]: exclude_id } },
                attributes,
                raw: true,
            });
        }
        return User.findOne({ where: { email }, attributes, raw: true });
    }

    async create(
        username: string, email: string, password_hash: string,
        display_name: string, transaction?: Transaction,
        role: 'user' | 'admin' = 'user',
    ): Promise<string> {
        const user = await User.create(
            { username, email, password_hash, display_name, role },
            { transaction },
        );
        return user.id;
    }

    async find_by_id_with_transaction(id: string, transaction: Transaction): Promise<UserVO | null> {        const row = await User.findByPk(id, { attributes: [...USER_ATTRS], raw: true, transaction }) as unknown as RawUserRow | null;
        return row ? to_user_vo(row) : null;
    }

    async find_password_hash(id: string): Promise<string | null> {
        const row = await User.findByPk(id, { attributes: ['password_hash'], raw: true });
        return row?.password_hash ?? null;
    }

    async update_profile(id: string, fields: { display_name?: string; email?: string }): Promise<void> {
        const updates: Record<string, unknown> = {};
        if (fields.display_name !== undefined) updates.display_name = fields.display_name;
        if (fields.email !== undefined) updates.email = fields.email;
        await User.update(updates, { where: { id } });
    }

    async update_password(id: string, password_hash: string): Promise<void> {
        await User.update({ password_hash }, { where: { id } });
    }

    /** Merge-patch preferences JSON — shallow-merges top-level keys. */
    async update_preferences(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
        const user = await User.findByPk(id);
        if (!user) throw new Error(`User ${id} not found`);
        const merged = { ...(user.preferences ?? {}), ...patch };
        await User.update({ preferences: merged }, { where: { id } });
        return merged;
    }
}
