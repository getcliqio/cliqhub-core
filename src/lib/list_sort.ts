/**
 * List sorting — `sort_by` / `sort_dir` request fields and the ORDER BY they build.
 *
 * Every sortable list declares a fixed map from each public key to the
 * columns or expressions it orders by ({@link SortColumns}). Request input
 * only ever selects an entry of that map; it is never written into SQL.
 * {@link list_order} always ends the ORDER BY with the primary key ascending,
 * so rows with equal values keep one order and pages never overlap or skip.
 */

import { z } from 'zod';
import { col, fn, where, type OrderItem } from 'sequelize';

/** Sort direction as sent by clients. */
export type SortDir = 'asc' | 'desc';

/** SQL direction for an ORDER BY item. */
export type SqlDir = 'ASC' | 'DESC';

/** `sort_dir` request field (shared by every sortable list). */
export const SortDirField = z.enum(['asc', 'desc']).optional()
    .describe('Sort direction with sort_by (default asc); ties are broken by id ascending');

/**
 * `sort_by` request field: a closed enum of the list's keys.
 *
 * @param keys - The sortable keys, in the order they are documented.
 * @param what - What the default order is, for the description.
 */
export function sort_by_field<const K extends [string, ...string[]]>(keys: K, what: string) {
    return z.enum(keys).optional()
        .describe(`Sort column: ${keys.join(' | ')}. Omit for the default order (${what}).`);
}

/** Public sort key → the ORDER BY items it expands to in a direction. */
export type SortColumns<K extends string> = Record<K, (dir: SqlDir) => OrderItem[]>;

/** `dir` with NULLs last in both directions (Postgres puts NULLs first on DESC). */
export function nulls_last(dir: SqlDir): string {
    return `${dir} NULLS LAST`;
}

/**
 * ORDER BY for a list: the chosen key's columns in the asked direction, or
 * `fallback` (today's default order) when no key was asked for — always
 * followed by `tie_breaker` (primary key ascending).
 *
 * @param columns - The list's whitelist of sortable keys.
 * @param sort - The request's `sort_by` / `sort_dir`.
 * @param fallback - The list's default ORDER BY (without the tie-breaker).
 * @param tie_breaker - Primary-key ORDER BY item (default `id ASC`).
 */
export function list_order<K extends string>(
    columns: SortColumns<K>,
    sort: { sort_by?: K | null; sort_dir?: SortDir | null },
    fallback: OrderItem[],
    tie_breaker: OrderItem = ['id', 'ASC'],
): OrderItem[] {
    const build = sort.sort_by ? columns[sort.sort_by] : undefined;
    const head = build ? build(sort.sort_dir === 'desc' ? 'DESC' : 'ASC') : fallback;
    return [...head, tie_breaker];
}

/**
 * ORDER BY item that puts rows whose `column` equals `value` first (search
 * "exact match first"). `value` is passed as a Sequelize value, which
 * Sequelize escapes; it is never spliced into SQL text.
 *
 * @param column - Column name (a constant, never request input).
 * @param value - The value to match (request input is fine).
 */
export function equals_first(column: string, value: string): OrderItem {
    return [fn('COALESCE', where(col(column), value), false), 'DESC'];
}
