/** clamp_grant_to_grant — a restricted PAT cannot mint a wider one (S25). */
import { describe, it, expect } from 'vitest';
import { clamp_grant_to_grant } from '../../../src/auth/grants.js';

describe('clamp_grant_to_grant', () => {
    const ceiling = { domains: { orgs: ['o1'], realms: ['r1', 'r2'] }, access: { runs: ['read'] as const, teams: ['read', 'write'] as const } };

    it('narrows `*` domains to the ceiling', () => {
        const out = clamp_grant_to_grant({ domains: { orgs: '*', realms: '*' }, access: {} }, ceiling as never);
        expect(out.domains).toEqual({ orgs: ['o1'], realms: ['r1', 'r2'] });
    });

    it('drops ids outside the ceiling', () => {
        const out = clamp_grant_to_grant({ domains: { orgs: ['o1', 'o2'], realms: ['r2', 'r9'] }, access: {} }, ceiling as never);
        expect(out.domains).toEqual({ orgs: ['o1'], realms: ['r2'] });
    });

    it('caps access levels per entity and drops entities the ceiling lacks', () => {
        const out = clamp_grant_to_grant({
            domains: {},
            access: { runs: ['read', 'write', 'admin'], teams: ['write'], users: ['admin'] },
        } as never, ceiling as never);
        expect(out.access).toEqual({ runs: ['read'], teams: ['write'] });
    });

    it('a `*` ceiling leaves domains alone', () => {
        const out = clamp_grant_to_grant(
            { domains: { orgs: ['o5'], realms: '*' }, access: {} },
            { domains: { orgs: '*', realms: '*' }, access: {} },
        );
        expect(out.domains).toEqual({ orgs: ['o5'], realms: '*' });
    });
});
