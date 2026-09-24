/**
 * Stable UUID for a legacy Hub integer id (one-shot int→uuid migrator only).
 * Format: 00000000-0000-4000-8000- + 12 hex digits of the int.
 *
 * Do NOT use these as long-lived fixture ids — remint migrator replaces them
 * with gen_random_uuid(). Test fixtures use HUB_UUID below (random-looking).
 */

export function hub_legacy_uuid(n: number): string {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffffffff) {
        throw new Error(`hub_legacy_uuid: out of range: ${n}`);
    }
    return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/**
 * Well-known fixture ids (stable across test runs; not legacy-pattern).
 * New inserts in prod use gen_random_uuid().
 */
export const HUB_UUID = {
    alice: 'a1111111-1111-4111-8111-111111111111',
    bob: 'b2222222-2222-4222-8222-222222222222',
    org_admin: 'c3333333-3333-4333-8333-333333333333',
    site_admin: 'd9999999-9999-4999-8999-999999999999',
    org_1: 'e1111111-1111-4111-8111-111111111101',
    scope_1: 'f1111111-1111-4111-8111-111111111101',
    scope_2: 'f2222222-2222-4222-8222-222222222202',
} as const;
