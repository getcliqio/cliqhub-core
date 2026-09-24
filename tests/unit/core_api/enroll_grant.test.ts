import { describe, it, expect } from 'vitest';
import { resolve_enroll_realm_and_grant } from '../../../src/lib/enroll_grant.js';
import { default_daemon_grant } from '../../../src/auth/grants.js';

describe('resolve_enroll_realm_and_grant', () => {
    it('uses auth realm and narrows grant', () => {
        const grant = default_daemon_grant(['r1', 'r2']);
        const result = resolve_enroll_realm_and_grant({
            token_permissions: grant as unknown as Record<string, unknown>,
            auth_realm_id: 'r1',
        });
        expect(result.realm_id).toBe('r1');
        expect(result.permissions.domains.realms).toEqual(['r1']);
        expect(result.permissions.access.dispatch).toContain('write');
    });

    it('prefers requested realm when in grant', () => {
        const grant = default_daemon_grant(['r1', 'r2']);
        const result = resolve_enroll_realm_and_grant({
            token_permissions: grant as unknown as Record<string, unknown>,
            auth_realm_id: 'r1',
            requested_realm_id: 'r2',
        });
        expect(result.realm_id).toBe('r2');
        expect(result.permissions.domains.realms).toEqual(['r2']);
    });

    it('rejects realm not in token domains', () => {
        const grant = default_daemon_grant(['r1']);
        expect(() => resolve_enroll_realm_and_grant({
            token_permissions: grant as unknown as Record<string, unknown>,
            requested_realm_id: 'r-other',
        })).toThrow(/not granted/);
    });

    it('requires realm when none provided', () => {
        expect(() => resolve_enroll_realm_and_grant({
            token_permissions: default_daemon_grant(['r1']) as unknown as Record<string, unknown>,
        })).toThrow(/realm_id is required/);
    });

    it('rejects when daemons write is missing', () => {
        expect(() => resolve_enroll_realm_and_grant({
            token_permissions: {
                domains: { realms: ['r1'] },
                access: { daemons: [], dispatch: ['write'] },
            },
            requested_realm_id: 'r1',
        })).toThrow(/daemons:write/);
    });
});
