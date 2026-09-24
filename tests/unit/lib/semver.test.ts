import { describe, it, expect } from 'vitest';
import { parse_semver, compare_semver, max_semver, sort_semver_desc } from '../../../src/lib/semver.js';

describe('parse_semver', () => {
    it('parses major.minor.patch', () => {
        expect(parse_semver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: '' });
    });

    it('parses prerelease', () => {
        expect(parse_semver('1.0.0-beta.1')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: 'beta.1' });
    });

    it('returns null for garbage', () => {
        expect(parse_semver('not-a-version')).toBeNull();
        expect(parse_semver('1.2')).toBeNull();
        expect(parse_semver('1')).toBeNull();
        expect(parse_semver('')).toBeNull();
        expect(parse_semver(null)).toBeNull();
        expect(parse_semver(undefined)).toBeNull();
    });

    it('trims whitespace', () => {
        expect(parse_semver('  1.2.3  ')?.major).toBe(1);
    });
});

describe('compare_semver', () => {
    it('orders by major then minor then patch', () => {
        expect(compare_semver('2.0.0', '1.9.9')).toBeGreaterThan(0);
        expect(compare_semver('1.2.0', '1.1.9')).toBeGreaterThan(0);
        expect(compare_semver('1.1.2', '1.1.1')).toBeGreaterThan(0);
    });

    it('regression: 1.1.2 > 1.1.0 (the actual hello-world bug)', () => {
        expect(compare_semver('1.1.2', '1.1.0')).toBeGreaterThan(0);
        expect(compare_semver('1.1.0', '1.1.2')).toBeLessThan(0);
    });

    it('regression: 1.10.0 > 1.9.0 (natural numeric, not lex sort)', () => {
        expect(compare_semver('1.10.0', '1.9.0')).toBeGreaterThan(0);
    });

    it('equal versions return 0', () => {
        expect(compare_semver('1.2.3', '1.2.3')).toBe(0);
    });

    it('prerelease is older than stable at same triple', () => {
        expect(compare_semver('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
        expect(compare_semver('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);
    });

    it('handles invalid versions (invalid sorts older)', () => {
        expect(compare_semver('not-a-version', '1.0.0')).toBeLessThan(0);
        expect(compare_semver('1.0.0', 'not-a-version')).toBeGreaterThan(0);
        expect(compare_semver('junk', 'trash')).toBe(0);
    });
});

describe('max_semver', () => {
    it('returns the highest semver in list', () => {
        expect(max_semver(['1.0.0', '2.0.0', '1.5.0'])).toBe('2.0.0');
    });

    it('regression: picks 1.1.2 not 1.1.0 for hello-world versions', () => {
        expect(max_semver(['1.1.2', '1.0.2', '1.1.0'])).toBe('1.1.2');
    });

    it('regression: picks 1.10.0 over 1.9.0 (natural numeric)', () => {
        expect(max_semver(['1.9.0', '1.10.0', '1.2.0'])).toBe('1.10.0');
    });

    it('returns null for empty list', () => {
        expect(max_semver([])).toBeNull();
    });

    it('returns null when all invalid', () => {
        expect(max_semver(['junk', 'trash', ''])).toBeNull();
    });

    it('skips invalid entries', () => {
        expect(max_semver(['junk', '1.0.0', 'trash'])).toBe('1.0.0');
    });
});

describe('sort_semver_desc', () => {
    it('returns newest-first', () => {
        const input = [
            { version: '1.1.0', extra: 'a' },
            { version: '1.1.2', extra: 'b' },
            { version: '1.0.2', extra: 'c' },
        ];
        const sorted = sort_semver_desc(input);
        expect(sorted.map((r) => r.version)).toEqual(['1.1.2', '1.1.0', '1.0.2']);
        expect(sorted[0].extra).toBe('b');
    });

    it('does not mutate input', () => {
        const input = [{ version: '1.0.0' }, { version: '2.0.0' }];
        const sorted = sort_semver_desc(input);
        expect(input.map((r) => r.version)).toEqual(['1.0.0', '2.0.0']);
        expect(sorted.map((r) => r.version)).toEqual(['2.0.0', '1.0.0']);
    });

    it('returns empty array for empty input', () => {
        expect(sort_semver_desc([])).toEqual([]);
    });
});
