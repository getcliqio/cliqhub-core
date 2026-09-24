import { describe, it, expect } from 'vitest';
import {
    assert_access,
    assert_admin_access,
    resolve_effective_grant,
} from '../../../src/auth/assert_grant.js';
import { ALICE, SITE_ADMIN, UNAUTHED } from '../../helpers/fixtures.js';
import type { AuthContext } from '../../../src/types/vo.js';

function with_grant(auth: AuthContext, permissions: AuthContext['token_permissions']): AuthContext {
    return { ...auth, token_permissions: permissions };
}

describe('assert_grant — positive', () => {
    it('site admin resolves full grant without token_permissions', () => {
        const grant = resolve_effective_grant(SITE_ADMIN);
        expect(grant.domains.orgs).toBe('*');
        expect(assert_admin_access(SITE_ADMIN, 'users')).toEqual(grant);
    });

    it('member default grant allows teams write', () => {
        expect(() => assert_access(ALICE, 'teams', 'write')).not.toThrow();
    });

    it('explicit grant with teams write passes', () => {
        const auth = with_grant(ALICE, {
            domains: { scopes: ['alice'] },
            access: { teams: ['read', 'write'] },
        });
        expect(() => assert_access(auth, 'teams', 'write')).not.toThrow();
    });

    it('non-admin with entity admin on grant passes assert_admin_access', () => {
        const auth = with_grant(ALICE, {
            domains: { orgs: '*', scopes: '*', realms: '*' },
            access: { users: ['read', 'write', 'admin'] },
        });
        expect(() => assert_admin_access(auth, 'users')).not.toThrow();
    });
});

describe('assert_grant — negative', () => {
    it('unauthenticated resolve throws 401', () => {
        expect(() => resolve_effective_grant(UNAUTHED)).toThrow('Authentication required');
    });

    it('member cannot assert users admin', () => {
        expect(() => assert_admin_access(ALICE, 'users')).toThrow('Admin access required');
    });

    it('PAT missing teams write is forbidden', () => {
        const auth = with_grant(ALICE, {
            domains: { scopes: ['alice'] },
            access: { teams: ['read'] },
        });
        expect(() => assert_access(auth, 'teams', 'write')).toThrow('Missing teams:write');
    });

    it('explicit empty teams levels denies teams read', () => {
        const auth = with_grant(ALICE, {
            domains: { scopes: ['alice'] },
            access: { teams: [] },
        });
        expect(() => assert_access(auth, 'teams', 'read')).toThrow('Missing teams:read');
    });
});

describe('assert_grant — edge', () => {
    it('write need is satisfied by admin level', () => {
        const auth = with_grant(ALICE, {
            domains: { scopes: ['alice'] },
            access: { teams: ['admin'] },
        });
        expect(() => assert_access(auth, 'teams', 'write')).not.toThrow();
        expect(() => assert_access(auth, 'teams', 'read')).not.toThrow();
    });

    it('legacy empty token_permissions falls back to role defaults', () => {
        const auth = with_grant(ALICE, {});
        const grant = resolve_effective_grant(auth);
        expect(grant.access?.teams).toContain('write');
    });
});

describe('assert_grant — daemon_token', () => {
    const daemon_auth: AuthContext = {
        ...ALICE,
        auth_via: 'daemon_token',
        realm_id: 'realm-1',
        token_permissions: {
            domains: { realms: ['realm-1'] },
            access: {
                daemons: ['write'],
                dispatch: ['write'],
                runs: ['read', 'write'],
            },
        },
    };

    it('uses daemon grant — allows daemons write, denies teams write', () => {
        expect(() => assert_access(daemon_auth, 'daemons', 'write')).not.toThrow();
        expect(() => assert_access(daemon_auth, 'dispatch', 'write')).not.toThrow();
        expect(() => assert_access(daemon_auth, 'teams', 'write')).toThrow('Missing teams:write');
    });

    it('empty access levels deny daemons write after normalize override', () => {
        const auth: AuthContext = {
            ...daemon_auth,
            token_permissions: {
                domains: { realms: ['realm-1'] },
                access: { daemons: [], dispatch: ['write'] },
            },
        };
        expect(() => assert_access(auth, 'daemons', 'write')).toThrow('Missing daemons:write');
        expect(() => assert_access(auth, 'dispatch', 'write')).not.toThrow();
    });
});
