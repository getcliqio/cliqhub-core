import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

export interface AuthUser {
    id: string;
    username: string;
    display_name: string;
    email: string;
    role: 'user' | 'admin';
    suspended_at: string | null;
    suspended_reason: string;
    created_at: string;
}

export interface AuthScope {
    id: string;
    slug: string;
    display_name: string | null;
    visibility: 'public' | 'private';
    scope_type: 'user' | 'org';
    owner_id: string;
    org_id: string | null;
}

export interface AuthContext {
    user: AuthUser | null;
    org_slugs: string[];
    org_ids: string[];
    scopes: AuthScope[];
    auth_via?: 'jwt' | 'pat' | 'daemon_token';
    token_permissions?: {
        domains?: {
            orgs?: Array<string | '*'> | '*';
            scopes?: Array<string | '*'> | '*';
            realms?: Array<string | '*'> | '*';
        };
        access?: Partial<Record<string, Array<'read' | 'write' | 'admin'>>> | string;
        org_ids?: string[];
    };
}

const ALICE_SCOPE: AuthScope = {
    id: hub_legacy_uuid(1), slug: 'alice', display_name: null,
    visibility: 'public', scope_type: 'user', owner_id: hub_legacy_uuid(1), org_id: null,
};

export const ALICE: AuthContext = {
    user: {
        id: hub_legacy_uuid(1), username: 'alice', display_name: 'Alice',
        email: 'alice@test.com', role: 'user',
        suspended_at: null, suspended_reason: '',
        created_at: '2025-01-01T00:00:00Z',
    },
    org_slugs: [],
    org_ids: [],
    scopes: [ALICE_SCOPE],
};

const BOB_SCOPE: AuthScope = {
    id: hub_legacy_uuid(2), slug: 'bob', display_name: null,
    visibility: 'public', scope_type: 'user', owner_id: hub_legacy_uuid(2), org_id: null,
};

export const BOB: AuthContext = {
    user: {
        id: hub_legacy_uuid(2), username: 'bob', display_name: 'Bob',
        email: 'bob@test.com', role: 'user',
        suspended_at: null, suspended_reason: '',
        created_at: '2025-01-01T00:00:00Z',
    },
    org_slugs: [],
    org_ids: [],
    scopes: [BOB_SCOPE],
};

export const SITE_ADMIN: AuthContext = {
    user: {
        id: hub_legacy_uuid(99), username: 'admin', display_name: 'Admin',
        email: 'admin@test.com', role: 'admin',
        suspended_at: null, suspended_reason: '',
        created_at: '2025-01-01T00:00:00Z',
    },
    org_slugs: [],
    org_ids: [],
    scopes: [{
        id: hub_legacy_uuid(99), slug: 'admin', display_name: null,
        visibility: 'public', scope_type: 'user', owner_id: hub_legacy_uuid(99), org_id: null,
    }],
};

const ACME_SCOPE: AuthScope = {
    id: hub_legacy_uuid(10), slug: 'acme', display_name: 'Acme',
    visibility: 'public', scope_type: 'org', owner_id: hub_legacy_uuid(3), org_id: hub_legacy_uuid(1),
};

export const ORG_ADMIN: AuthContext = {
    user: {
        id: hub_legacy_uuid(3), username: 'orgadmin', display_name: 'Org Admin',
        email: 'orgadmin@test.com', role: 'user',
        suspended_at: null, suspended_reason: '',
        created_at: '2025-01-01T00:00:00Z',
    },
    org_slugs: ['acme'],
    org_ids: [hub_legacy_uuid(1)],
    scopes: [
        { id: hub_legacy_uuid(3), slug: 'orgadmin', display_name: null, visibility: 'public', scope_type: 'user', owner_id: hub_legacy_uuid(3), org_id: null },
        ACME_SCOPE,
    ],
};

export const UNAUTHED: AuthContext = {
    user: null,
    org_slugs: [],
    org_ids: [],
    scopes: [],
};
