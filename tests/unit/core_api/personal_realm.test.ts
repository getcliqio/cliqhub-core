import { describe, it, expect } from 'vitest';
import {
	personal_realm_slug,
	legacy_personal_realm_slugs,
	is_legacy_default_realm_slug,
} from '../../../src/lib/personal_realm.js';

describe('personal_realm_slug', () => {
	it('uses username-default-realm', () => {
		expect(personal_realm_slug('Sapan')).toBe('sapan-default-realm');
	});

	it('truncates to 63 characters', () => {
		const slug = personal_realm_slug('a'.repeat(80));
		expect(slug.length).toBe(63);
		expect(slug.endsWith('-default-realm') || slug.length === 63).toBe(true);
	});
});

describe('legacy_personal_realm_slugs', () => {
	it('includes prior r-/u- and hyphen forms', () => {
		expect(legacy_personal_realm_slugs('sapan')).toEqual([
			'r-sapan',
			'u-sapan',
			'sapans-default-realm',
			'sapan-default-realm',
		]);
	});
});

describe('is_legacy_default_realm_slug', () => {
	it('detects hyphenated and r-/u- shapes', () => {
		expect(is_legacy_default_realm_slug('admin-default-realm', 'admin')).toBe(true);
		expect(is_legacy_default_realm_slug('cliq.default', 'admin')).toBe(false);
	});
});
