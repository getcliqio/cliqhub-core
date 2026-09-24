import { ApiError } from './api_error.js';

/**
 * A parsed org-scoped realm slug: `org_slug.realm_slug`.
 *
 * Unambiguous because org slugs never contain dots (`[a-z][a-z0-9-]*`)
 * and realm slugs no longer allow dots (reserved as separator).
 */
export interface QualifiedSlug {
    org_slug: string;
    realm_slug: string;
}

/**
 * Parse a qualified realm slug (`org.realm`) into its components.
 * Splits on the first dot.
 *
 * @example parse_qualified_slug('measureone.ops') → { org_slug: 'measureone', realm_slug: 'ops' }
 * @example parse_qualified_slug('elan.default')   → { org_slug: 'elan', realm_slug: 'default' }
 */
export function parse_qualified_slug(input: string): QualifiedSlug {
    const trimmed = input.trim().toLowerCase();
    const dot = trimmed.indexOf('.');
    if (dot < 1 || dot === trimmed.length - 1) {
        throw ApiError.bad_request(
            `Invalid qualified realm slug '${input}'. Expected format: org.realm`,
        );
    }
    return {
        org_slug: trimmed.slice(0, dot),
        realm_slug: trimmed.slice(dot + 1),
    };
}

/**
 * Format org + realm slugs into the qualified `org.realm` form.
 */
export function format_qualified_slug(org_slug: string, realm_slug: string): string {
    return `${org_slug.trim().toLowerCase()}.${realm_slug.trim().toLowerCase()}`;
}

/**
 * Check whether a string looks like a qualified slug (contains a dot).
 * Useful for backward-compat code paths that accept either bare or qualified.
 */
export function is_qualified_slug(input: string): boolean {
    return input.includes('.');
}
