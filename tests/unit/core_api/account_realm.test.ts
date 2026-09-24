import { describe, it, expect } from 'vitest';
import {
    account_default_realm_slug,
    account_realm_slug,
} from '../../../src/lib/account_realm.js';

describe('account_realm slug helpers', () => {
    it('default realm slug is always "default" (org boundary via UNIQUE(org_id, slug))', () => {
        expect(account_default_realm_slug('measureone')).toBe('default');
        expect(account_default_realm_slug('@MeasureOne')).toBe('default');
    });

    it('named realm slug strips dots (dots not allowed in slugs)', () => {
        expect(account_realm_slug('measureone', 'staging')).toBe('staging');
        expect(account_realm_slug('measureone', 'foo.bar')).toBe('foo-bar');
    });
});
