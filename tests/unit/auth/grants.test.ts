import { describe, it, expect } from 'vitest';
import {
    default_grant_for_subject,
    default_daemon_grant,
    normalize_grant,
    has_access,
    clamp_grant_to_subject,
} from '../../../src/auth/grants.js';

describe('grants', () => {
    it('admin subject gets wildcard domains and admin access', () => {
        const grant = default_grant_for_subject({
            role: 'admin',
            org_ids: ['1'],
            scope_slugs: ['acme'],
            realm_ids: ['r1'],
        });
        expect(grant.domains.orgs).toBe('*');
        expect(grant.domains).not.toHaveProperty('scopes');
        expect(has_access(grant, 'users', 'admin')).toBe(true);
        expect(has_access(grant, 'orgs', 'admin')).toBe(true);
        expect(has_access(grant, 'scopes', 'admin')).toBe(true);
    });

    it('member subject domains are orgs/realms only; namespaces via scopes resource', () => {
        const grant = default_grant_for_subject({
            role: 'user',
            org_ids: ['42'],
            scope_slugs: ['acme'],
            realm_ids: ['realm-1'],
        });
        expect(grant.domains.orgs).toEqual(['42']);
        expect(grant.domains.realms).toEqual(['realm-1']);
        expect(grant.domains).not.toHaveProperty('scopes');
        expect(has_access(grant, 'teams', 'write')).toBe(true);
        expect(has_access(grant, 'scopes', 'write')).toBe(true);
        expect(has_access(grant, 'users', 'admin')).toBe(false);
        expect(has_access(grant, 'dispatch', 'write')).toBe(true);
    });

    it('daemon grant is realm-scoped write', () => {
        const grant = default_daemon_grant('realm-9');
        expect(grant.domains.realms).toEqual(['realm-9']);
        expect(has_access(grant, 'daemons', 'write')).toBe(true);
        expect(has_access(grant, 'dispatch', 'write')).toBe(true);
        expect(has_access(grant, 'teams', 'write')).toBe(false);
    });

    it('daemon grant accepts multiple realms', () => {
        const grant = default_daemon_grant(['realm-a', 'realm-b']);
        expect(grant.domains.realms).toEqual(['realm-a', 'realm-b']);
        expect(has_access(grant, 'dispatch', 'write')).toBe(true);
    });

    it('normalizes legacy org_ids + access string', () => {
        const fallback = default_grant_for_subject({
            role: 'user',
            org_ids: ['1', '2'],
            scope_slugs: ['a'],
            realm_ids: [],
        });
        const grant = normalize_grant({ org_ids: ['1'], access: 'full' }, fallback);
        expect(grant.domains.orgs).toEqual(['1']);
        expect(grant.domains).not.toHaveProperty('scopes');
        expect(has_access(grant, 'users', 'admin')).toBe(true);
    });

    it('strips legacy domains.scopes from new-shape grants', () => {
        const fallback = default_grant_for_subject({
            role: 'user',
            org_ids: ['1'],
            scope_slugs: ['a'],
            realm_ids: ['r'],
        });
        const grant = normalize_grant(
            {
                domains: { orgs: ['1'], scopes: ['ignore-me'], realms: ['r'] },
                access: { teams: ['read'] },
            },
            fallback,
        );
        expect(grant.domains).toEqual({ orgs: ['1'], realms: ['r'] });
        expect(has_access(grant, 'teams', 'read')).toBe(true);
    });

    it('clamps wildcard domains for non-admin subjects', () => {
        const subject = {
            role: 'user' as const,
            org_ids: ['7'],
            scope_slugs: ['only'],
            realm_ids: ['r'],
        };
        const clamped = clamp_grant_to_subject(
            {
                domains: { orgs: '*', realms: '*' },
                access: { teams: ['read', 'write'] },
            },
            subject,
        );
        expect(clamped.domains.orgs).toEqual(['7']);
        expect(clamped.domains.realms).toEqual(['r']);
        expect(clamped.domains).not.toHaveProperty('scopes');
    });
});
