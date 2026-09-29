import { z } from 'zod';

export const signup_schema = z.object({
    username: z.string().min(1, 'username is required'),
    email: z.string().min(1, 'email is required'),
    password: z.string().min(1, 'password is required'),
});

/** Body for POST /internal/auth/authenticate_user. */
export const authenticate_user_schema = z.object({
    username: z.string().min(1, 'username is required'),
    password: z.string().min(1, 'password is required'),
});

export const issue_session_token_schema = z.object({
    user_id: z.string().uuid(),
});

export const revoke_session_token_schema = z.object({
    token: z.string().min(1, 'token is required'),
});

import { UserData } from '../users/types.js';
import { ScopeData } from '../scopes/types.js';
import { OrgData } from '../orgs/types.js';

/**
 * Auth session response — returned by login, signup, and /v1/auth/me.
 * The JWT is only present in the login/signup response; never on /me.
 */
export const MeResponseData = z.object({
    user: UserData
        .describe('Authenticated user profile'),
    orgs: z.array(OrgData)
        .describe('Orgs the user is a member of'),
    scopes: z.array(ScopeData)
        .describe('Package-namespace scopes the user has publish access to'),
    impersonating: z.object({
        actor_id: z.string().uuid(),
        actor_username: z.string(),
    }).nullable()
        .describe('Set when an admin is acting as this user; null otherwise'),
});

export type MeResponseData = z.infer<typeof MeResponseData>;

/**
 * Login / signup response — MeResponseData plus a short-lived JWT.
 */
export const LoginResponseData = MeResponseData.extend({
    token: z.string().optional()
        .describe('Short-lived session JWT (BFF consumes and does not forward to SPA)'),
});

export type LoginResponseData = z.infer<typeof LoginResponseData>;
