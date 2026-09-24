import { describe, it, expect } from 'vitest';
import {
    generate_token_schema,
    get_tokens_schema,
    revoke_token_schema,
    permissions_schema,
} from '../../../src/schemas/tokens_schemas.js';

describe('tokens_schemas', () => {
    it('accepts user type', () => {
        const parsed = generate_token_schema.parse({ type: 'user', name: 'x' });
        expect(parsed.type).toBe('user');
    });

    it('rejects personal', () => {
        expect(() => generate_token_schema.parse({ type: 'personal', name: 'x' })).toThrow();
    });

    it('rejects daemon type on generate (use type realm)', () => {
        expect(() => generate_token_schema.parse({
            type: 'daemon',
            realm_ids: ['r1'],
            name: 'x',
        })).toThrow();
    });

    it('accepts realm type with realm_ids', () => {
        const parsed = generate_token_schema.parse({ type: 'realm', realm_ids: ['r1'], name: 'enroll' });
        expect(parsed.type).toBe('realm');
        expect(parsed.realm_ids).toEqual(['r1']);
    });

    it('requires realm for type realm without domains', () => {
        expect(() => generate_token_schema.parse({ type: 'realm', name: 'd' })).toThrow();
    });

    it('rejects singular realm_id on generate', () => {
        expect(() => generate_token_schema.parse({
            type: 'realm',
            realm_id: 'r1',
            name: 'enroll',
        } as { type: 'realm'; name: string })).toThrow();
    });

    it('accepts multi realm_ids for realm', () => {
        const parsed = generate_token_schema.parse({
            type: 'realm',
            realm_ids: ['r1', 'r2'],
            name: 'multi',
        });
        expect(parsed.type).toBe('realm');
        expect(parsed.realm_ids).toEqual(['r1', 'r2']);
    });

    it('coerces numeric token_id to string', () => {
        const parsed = revoke_token_schema.parse({ type: 'user', token_id: 5 });
        expect(parsed.token_id).toBe('5');
        expect(parsed.type).toBe('user');
    });

    it('accepts query on get_tokens', () => {
        const parsed = get_tokens_schema.parse({ type: 'user', query: 'laptop' });
        expect(parsed.query).toBe('laptop');
    });

    it('rejects capability scopes on mint', () => {
        const parsed = generate_token_schema.parse({
            type: 'user',
            name: 'x',
            scopes: ['dispatch'],
        } as { type: 'user'; name: string });
        expect('scopes' in parsed).toBe(false);
    });

    describe('permissions grant', () => {
        it('expands domains + access with allowed levels', () => {
            const parsed = permissions_schema.parse({
                domains: { orgs: [1], realms: ['r1'] },
                access: { teams: ['read', 'write'], dispatch: ['write'] },
            });
            expect(parsed.domains?.orgs).toEqual([1]);
            expect(parsed.domains?.realms).toEqual(['r1']);
            expect(parsed.access?.teams).toEqual(['read', 'write']);
        });

        it('accepts wildcard domains', () => {
            const parsed = permissions_schema.parse({
                domains: { orgs: '*', realms: '*' },
            });
            expect(parsed.domains?.orgs).toBe('*');
            expect(parsed.domains?.realms).toBe('*');
        });

        it('rejects unknown access levels', () => {
            expect(() => permissions_schema.parse({
                access: { teams: ['owner'] },
            })).toThrow();
        });
    });
});
