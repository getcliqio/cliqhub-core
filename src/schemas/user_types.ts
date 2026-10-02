import { z } from 'zod';
import { SortDirField, sort_by_field } from '../lib/list_sort.js';

export const users_get_schema = z.object({
    org_id: z.string().uuid().optional(),
    /**
     * When set, search Hub users for realm invite (excludes current members).
     * Replaces /v1/realms/search_users.
     */
    realm_id: z.string().min(1).optional(),
    /** Substring match on username/email (POST body only). Preferred over `search`. */
    query: z.string().optional(),
    /** @deprecated use `query` */
    search: z.string().optional(),
    /** Site-admin hub list only: filter by hub role. */
    role: z.enum(['user', 'admin']).optional(),
    /** Site-admin hub list only: true = suspended accounts, false = active ones. */
    suspended: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
    /** Site-admin hub list only (400 with org_id / realm_id). */
    sort_by: sort_by_field(['username', 'role', 'created_at', 'suspended_at'],
        'exact username match first when searching, then newest first; site-admin hub list only'),
    sort_dir: SortDirField,
    /** Site-admin hub list only: also list soft-deleted users (status `deleted`). */
    include_deleted: z.boolean().optional(),
});

export const users_get_by_id_schema = z.object({
    user_id: z.string().uuid(),
    /**
     * When true, include the JSON preferences bag (e.g. event_alerts).
     * Default false — preferences are not part of the directory detail.
     */
    include_preferences: z.boolean().optional().default(false),
});

/** `users/new`: the person gets a "Set your password" email; no password here. */
export const users_new_schema = z.object({
    username: z.string().min(1, 'username is required'),
    email: z.string().email('Invalid email address'),
    display_name: z.string().optional(),
    role: z.enum(['user', 'admin']).optional(),
    /** Restore the deleted user that holds the username or email (`409 deleted`) instead of refusing. */
    reactivate: z.boolean().optional(),
});

export const users_update_schema = z.object({
    user_id: z.string().uuid().optional(),
    display_name: z.string().optional(),
    email: z.string().optional(),
    /**
     * Shallow-merge into users.preferences JSONB.
     * Events UI: { event_alerts: { hug, my_runs, all, *_seen_at } }.
     */
    preferences: z.record(z.string(), z.unknown()).optional(),
}).refine(
    (d) =>
        d.display_name !== undefined
        || d.email !== undefined
        || d.preferences !== undefined,
    { message: 'At least one of display_name, email, or preferences is required' },
);

export const users_delete_schema = z.object({
    user_id: z.string().uuid(),
});

export const users_suspend_schema = z.object({
    user_id: z.string().uuid(),
    reason: z.string().optional(),
});

export const users_unsuspend_schema = z.object({
    user_id: z.string().uuid(),
});

/** `users/reset_password` as a site admin: email the user a reset link. */
export const users_reset_password_schema = z.object({
    user_id: z.string().uuid(),
}).strict();

/** `users/reset_password` signed out ("Forgot password"): the body carries only the email. */
export const users_forgot_password_schema = z.object({
    email: z.string().trim().toLowerCase().email('Invalid email address'),
}).strict();

export const users_set_role_schema = z.object({
    user_id: z.string().uuid(),
    role: z.enum(['user', 'admin'], { message: 'Role must be "user" or "admin"' }),
});

/** Assign an org role definition to a member (not site-admin set_role). */
export const users_update_role_schema = z.object({
    user_id: z.string().uuid(),
    org_id: z.string().uuid(),
    role_id: z.string().uuid(),
});

/** `users/change_password` signed in: prove the current password. */
export const users_change_password_schema = z.object({
    current_password: z.string().min(1, 'current_password is required'),
    new_password: z.string().min(1, 'new_password is required'),
});

/** `users/change_password` from an emailed set-password / reset link: the token is the credential. */
export const users_change_password_with_token_schema = z.object({
    reset_token: z.string().min(1, 'reset_token is required'),
    new_password: z.string().min(1, 'new_password is required'),
}).strict();


/**
 * Canonical wire shape for a Hub user.
 * All controllers and BFF layers must use this type — retire UserDto/UserVo for wire responses.
 */
export const UserData = z.object({
    id: z.string().uuid()
        .describe('User UUID'),
    username: z.string()
        .describe('Unique username / handle'),
    display_name: z.string()
        .describe('Human-readable display name'),
    email: z.string()
        .describe('Primary email address'),
    role: z.enum(['user', 'admin'])
        .describe('Site-level role'),
    suspended_at: z.string().nullable()
        .describe('ISO timestamp when account was suspended; null if active'),
    suspended_reason: z.string()
        .describe('Admin note on suspension; empty string when not suspended'),
    created_at: z.string()
        .describe('ISO timestamp of account creation'),
    preferences: z.record(z.unknown())
        .describe('User-controlled preference bag'),
});

export type UserData = z.infer<typeof UserData>;


// ── Internal persistence shapes ─────────────────────────────────────────────

export type UserVo = {
    id: string;
    username: string;
    display_name: string;
    email: string;
    role: 'user' | 'admin';
    suspended_at: string | null;
    suspended_reason: string;
    created_at: string;
    preferences: Record<string, unknown>;
};

export type UserLoginRowVo = {
    id: string;
    username: string;
    /** NULL in the database for an invited user who never set a password: refuse sign-in before verifying. */
    password_hash: string;
    role: 'user' | 'admin';
    suspended_at: string | null;
    status: 'invited' | 'active' | 'suspended';
    /** ISO timestamp when the account was soft-deleted. */
    deleted_at: string | null;
};

export type UserDto = {
    id: string;
    username: string;
    display_name: string;
    email: string;
    role: string;
    suspended_at: string | null;
    suspended_reason: string;
    created_at: string;
};

/** @deprecated Use PascalCase `*Vo` names. */
export type UserVO = UserVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type UserLoginRowVO = UserLoginRowVo;
/** @deprecated Prefer PascalCase `*Dto` names. */
export type UserDTO = UserDto;
