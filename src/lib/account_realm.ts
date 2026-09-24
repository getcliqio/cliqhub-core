/**
 * Default realm slug — now just `default` for every org.
 * The org boundary is enforced by the UNIQUE(org_id, slug) constraint,
 * not by baking the org name into the slug.
 */

export function account_default_realm_slug(_account_slug: string): string {
	return 'default';
}

/**
 * Additional realm under an account.
 * @deprecated Dots are no longer allowed in realm slugs. Use the
 * realm name directly instead of prefixing with the account slug.
 */
export function account_realm_slug(_account_slug: string, realm_name: string): string {
	return realm_name.trim().toLowerCase().replace(/^@/, '').replace(/\./g, '-').slice(0, 63);
}

/** Display name for an org's default realm. */
export function account_default_realm_name(_account_slug: string): string {
    return 'default';
}

/** @deprecated Use account_default_realm_name(slug) instead. Kept for migration compat. */
export const ACCOUNT_DEFAULT_REALM_NAME = 'default';

/**
 * The personal account slug is always the username.
 * After the signup simplification, every user has (or will have) a personal
 * org whose slug === username. This function always returns the username,
 * guaranteeing the personal realm is `{username}.default`.
 */
export async function primary_account_slug_for_user(
	_user_id: string,
	username: string,
): Promise<string> {
	return username.trim().toLowerCase();
}
