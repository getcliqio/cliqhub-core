/** Personal / legacy default realm slug helpers. Target shape is `{account}.default`. */

export function personal_realm_slug(username: string): string {
	const user = username.trim().toLowerCase();
	return `${user}-default-realm`.slice(0, 63);
}

/** Display name for the account's personal default realm (slug/id stay unique). */
export const PERSONAL_REALM_NAME = 'default';

/** Older personal slug shapes (pre `{account}.default`). */
export function legacy_personal_realm_slugs(username: string): string[] {
	const user = username.trim().toLowerCase();
	const candidates = [
		`r-${user}`,
		`u-${user}`,
		`${user}s-default-realm`,
		personal_realm_slug(user),
	];
	return [...new Set(candidates.map((s) => s.slice(0, 63)))];
}

/** True when slug is a pre-dot-notation personal default. */
export function is_legacy_default_realm_slug(slug: string, username?: string): boolean {
	const s = slug.trim().toLowerCase();
	if (s.startsWith('r-') || s.startsWith('u-')) return true;
	if (s.endsWith('-default-realm')) return true;
	if (!username) return false;
	return legacy_personal_realm_slugs(username).includes(s);
}

/** @deprecated use {@link legacy_personal_realm_slugs} */
export function legacy_personal_realm_slug(username: string): string {
	return `u-${username.trim().toLowerCase()}`.slice(0, 63);
}
