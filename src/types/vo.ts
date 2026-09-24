/**
 * Value Objects — internal / persistence shapes.
 * Prefer `type` (not interface). PascalCase names; snake_case fields.
 */

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
    password_hash: string;
    role: 'user' | 'admin';
    suspended_at: string | null;
};

export type ScopeVo = {
    id: string;
    slug: string;
    display_name: string | null;
    visibility: 'public' | 'private';
    scope_type: 'user' | 'org';
    owner_id: string;
    org_id: string | null;
};

export type OrgMembershipVo = {
    slug: string;
    role: string;
    org_id: string;
};

export type ApiTokenRowVo = {
    id: string;
    type?: 'user' | 'realm';
    user_id: string;
    token_hash: string;
    permissions: TokenPermissionsVo;
};

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

export type ImpersonationVo = {
    actor_id: string;
    actor_username: string;
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
    /**
     * Active org context for this request. Resolved from `X-Org-Id` header
     * or defaults to the user's personal org (slug === username).
     */
    current_org_id?: string;
    /** How the Bearer credential was resolved (`pat` | `daemon_token`). */
    auth_via?: 'jwt' | 'pat' | 'daemon_token';
    /** @deprecated Act-as is a BFF session update; Core no longer embeds impersonation. */
    impersonation?: ImpersonationVo;
};

export type TeamVo = {
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
};

export type TeamListItemVo = {
    id: string;
    name: string;
    scope: string | null;
    description: string;
    author: string | null;
    latest_version: string | null;
    install_count: number;
    listed?: number;
};

export type TeamVersionVo = {
    version: string;
    changelog: string;
    published_at: string;
};

export type TeamVersionDetailVo = {
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
};

export type TeamTagVo = {
    team_id: string;
    tag: string;
};

export type TeamRoleVo = {
    name: string;
    content_md: string;
};

export type DraftVo = {
    id: string;
    user_id: string;
    title: string;
    team_json: string;
    created_at: string;
    updated_at: string;
};

export type DraftListItemVo = {
    id: string;
    title: string;
    updated_at: string;
};

/** @deprecated Use PascalCase `*Vo` names. */
export type UserVO = UserVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type UserLoginRowVO = UserLoginRowVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type ScopeVO = ScopeVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type OrgMembershipVO = OrgMembershipVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type ApiTokenRowVO = ApiTokenRowVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type TokenPermissionsVO = TokenPermissionsVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type ImpersonationVO = ImpersonationVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type TeamVO = TeamVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type TeamListItemVO = TeamListItemVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type TeamVersionVO = TeamVersionVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type TeamVersionDetailVO = TeamVersionDetailVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type TeamTagVO = TeamTagVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type TeamRoleVO = TeamRoleVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type DraftVO = DraftVo;
/** @deprecated Use PascalCase `*Vo` names. */
export type DraftListItemVO = DraftListItemVo;
