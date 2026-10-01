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

import { UserData } from './user_types.js';
import { ScopeData } from './scope_types.js';
import { OrgData } from './org_types.js';

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


// ── Internal auth context & persistence shapes ───────────────────────────────

import type { UserVo } from './user_types.js';

/** Token grant — see `auth/grants.ts`. Legacy org_ids/access string still accepted on read. */
export type TokenPermissionsVo = {
    domains?: {
        orgs?: Array<string | '*'> | '*';
        realms?: Array<string | '*'> | '*';
        /** @deprecated ignored — package namespaces come from scopes membership */
        scopes?: Array<string | '*'> | '*';
    };
    access?: Partial<Record<string, Array<'read' | 'write' | 'admin'>>> | string;
    /** @deprecated use domains.orgs */
    org_ids?: string[];
};

export type ApiTokenRowVo = {
    id: string;
    type?: 'user' | 'realm';
    user_id: string;
    token_hash: string;
    permissions: TokenPermissionsVo;
};

export type ImpersonationVo = {
    actor_id: string;
    actor_username: string;
};

export type ScopeVo = {
    id: string;
    slug: string;
    display_name: string | null;
    visibility: 'public' | 'private';
    scope_type: 'user' | 'org' | 'platform';
    owner_id: string | null;
    org_id: string | null;
};

export type AuthContext = {
    user: UserVo | null;
    org_slugs: string[];
    /** Hub org ids from live membership (not JWT claims alone). */
    org_ids: string[];
    scopes: ScopeVo[];
    token_permissions?: TokenPermissionsVo;
    /**
     * API capability scopes carried by the authenticating PAT
     * (JIRA plugin slice 1.6). Absent for JWT / daemon-token auth.
     */
    token_scopes?: string[];
    /** Set when authenticated with a daemon token (`cliq_dt_`) for a single primary realm. */
    realm_id?: string;
    /** How the Bearer credential was resolved (`pat` | `daemon_token`). */
    auth_via?: 'jwt' | 'pat' | 'daemon_token';
    /** @deprecated Act-as is a BFF session update; Core no longer embeds impersonation. */
    impersonation?: ImpersonationVo;
};

/** @deprecated Use PascalCase `*Vo` names. */
export type TokenPermissionsVO = TokenPermissionsVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type ApiTokenRowVO = ApiTokenRowVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type ImpersonationVO = ImpersonationVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type ScopeVO = ScopeVo;
