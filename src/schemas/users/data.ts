import { z } from 'zod';

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
