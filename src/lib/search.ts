/**
 * Substring search on text columns.
 */

/** Escapes `%`, `_` and `\` so `input` matches literally inside a LIKE / ILIKE pattern. */
export function escape_like(input: string): string {
    return input.replace(/[%_\\]/g, '\\$&');
}
