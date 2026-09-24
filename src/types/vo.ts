// Value Objects — internal DB row shapes.
// Grows per slice as repositories are added.

export interface UserVO {
    id: string;
    username: string;
    display_name: string;
    email: string;
    role: 'user' | 'admin';
    suspended_at: string | null;
    suspended_reason: string;
    created_at: string;
    preferences: Record<string, unknown>;
}

export interface UserLoginRowVO {
    id: string;
    username: string;
    password_hash: string;
    role: 'user' | 'admin';
    suspended_at: string | null;
}

export interface ScopeVO {
    id: string;
    slug: string;
    display_name: string | null;
    visibility: 'public' | 'private';
    scope_type: 'user' | 'org';
    owner_id: string;
    org_id: string | null;
}

export interface OrgMembershipVO {
    slug: string;
    role: string;
    org_id: string;
}

export interface ApiTokenRowVO {
    id: string;
    type?: 'user' | 'realm';
    user_id: string;
    token_hash: string;
    permissions: TokenPermissionsVO;
}

/** Token grant — see `auth/grants.ts`. Legacy org_ids/access string still accepted on read. */
export interface TokenPermissionsVO {
    domains?: {
        orgs?: Array<string | '*'> | '*';
        realms?: Array<string | '*'> | '*';
        /** @deprecated ignored — package namespaces come from scopes membership */
        scopes?: Array<string | '*'> | '*';
    };
    access?: Partial<Record<string, Array<'read' | 'write' | 'admin'>>> | string;
    /** @deprecated use domains.orgs */
    org_ids?: string[];
}

export interface ImpersonationVO {
    actor_id: string;
    actor_username: string;
}

export interface AuthContext {
    user: UserVO | null;
    org_slugs: string[];
    /** Hub org ids from live membership (not JWT claims alone). */
    org_ids: string[];
    scopes: ScopeVO[];
    token_permissions?: TokenPermissionsVO;
    /**
     * API capability scopes carried by the authenticating PAT
     * (JIRA plugin slice 1.6). Absent for JWT / daemon-token auth.
     * Empty array for a scoped token that happens to have no scopes
     * is coerced to `undefined` upstream so callers can gate on
     * "did the operator opt into least-privilege" cleanly.
     */
    token_scopes?: string[];
    /** Set when authenticated with a daemon token (`cliq_dt_`) for a single primary realm. */
    realm_id?: string;
    /**
     * Active org context for this request. Resolved from `X-Org-Id` header
     * or defaults to the user's personal org (slug === username).
     * Null for unauthenticated requests.
     */
    current_org_id?: string;
    /** How the Bearer credential was resolved (`pat` | `daemon_token`). */
    auth_via?: 'jwt' | 'pat' | 'daemon_token';
    /** @deprecated Act-as is a BFF session update; Core no longer embeds impersonation. */
    impersonation?: ImpersonationVO;
}

export interface TeamVO {
    id: string;
    name: string;
    scope: string | null;
    scope_type: 'user' | 'org' | null;
    description: string;
    author_id: string | null;
    license: string;
    visibility: 'public' | 'private' | 'draft';
    listed: number;
    created_at: string;
    updated_at: string;
    install_count: number;
}

export interface TeamListItemVO {
    id: string;
    name: string;
    scope: string | null;
    description: string;
    author: string | null;
    latest_version: string | null;
    install_count: number;
    listed?: number;
}

export interface TeamVersionVO {
    version: string;
    changelog: string;
    published_at: string;
}

export interface TeamVersionDetailVO {
    id: string;
    team_id: string;
    version: string;
    changelog: string;
    package_path: string;
    cliq_version: string | null;
    tools: string;
    workflow_json: string;
    readme: string;
    capability_json: string;
    agents_json: string;
    published_at: string;
}

export interface TeamTagVO {
    team_id: string;
    tag: string;
}

export interface TeamRoleVO {
    name: string;
    content_md: string;
}

export interface DraftVO {
    id: string;
    user_id: string;
    title: string;
    team_json: string;
    created_at: string;
    updated_at: string;
}

export interface DraftListItemVO {
    id: string;
    title: string;
    updated_at: string;
}
