import { z } from 'zod';
import { UserData } from '../users/data.js';
import { ScopeData } from '../scopes/data.js';
import { OrgData } from '../orgs/data.js';

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
