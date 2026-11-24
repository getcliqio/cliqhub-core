/**
 * A person's unanswered Hugs in one org, from getHugs (PLAN-gethugs-partner-ux.md §1): the count CliqHub's HUGs badge
 * shows, and the newest few (as getHugs lists them). getHugs answers it for its partner (`hugs/get` with `user_id`, `unanswered`, `with_total`),
 * so the count is exactly what the person's getHugs inbox shows as Waiting.
 *
 * - Cached per person and org for {@link TTL_MS}; the feed reader forgets an org's answers when one of its Hugs changes
 *   ({@link gethugs_unanswered_forget}), so the badge moves within seconds of a Hug opening or being answered. The
 *   cache is this Core instance's: another instance sees the change when its entry expires.
 * - getHugs unreachable or refusing: the last answer if there is one (marked `stale`), else `total: null` — never an
 *   error, so a slow getHugs can't break CliqHub's pages.
 */

import { QueryTypes } from 'sequelize';

import { get_sequelize } from '../db/sequelize.js';
import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';
import { gethugs_partner, type GethugsPartner } from './gethugs.service.js';

const log = get_logger('gethugs_unanswered');

/** How long an answer is kept (the feed reader forgets an org's sooner when its Hugs change). */
export const TTL_MS = 30_000;
/** The most Hugs listed (the badge needs only the count). */
export const MAX_LIMIT = 20;

/** One unanswered Hug, as getHugs lists it (its summary; the fields CliqHub uses). */
export interface UnansweredHug {
    id: string;
    title: string;
    workspace_id: string;
    created_at: number;
    expires_at: number;
    [key: string]: unknown;
}

export interface Unanswered {
    /** Every unanswered Hug; null when getHugs couldn't be asked and nothing is known yet. */
    total: number | null;
    /** The newest first (getHugs' order), up to the limit asked. */
    items: UnansweredHug[];
    /** The org or the person isn't in getHugs yet (nothing can be waiting there). */
    in_gethugs: boolean;
    /** An earlier answer, given because getHugs couldn't be asked just now. */
    stale?: true;
}

interface Entry { at: number; g_org: string; value: Unanswered; limit: number }
const cache = new Map<string, Entry>();
const key = (org_id: string, user_id: string) => `${org_id}:${user_id}`;

/** Forgets the cached answers of one getHugs org (any person), or of every org. */
export function gethugs_unanswered_forget(g_org?: string | null): void {
    if (!g_org) { cache.clear(); return; }
    for (const [k, e] of cache) if (e.g_org === g_org) cache.delete(k);
}

async function linked(org_id: string, kind: 'org' | 'user', cliq_id: string): Promise<string | null> {
    const [row] = await get_sequelize().query<{ gethugs_id: string }>(
        'SELECT gethugs_id FROM cliq.gethugs_links WHERE org_id = :org_id AND kind = :kind AND cliq_id = :cliq_id',
        { replacements: { org_id, kind, cliq_id }, type: QueryTypes.SELECT },
    );
    return row?.gethugs_id ?? null;
}

/**
 * `user_id`'s unanswered Hugs in the org `org_id` (they must be an active member), the newest `limit` listed.
 *
 * @throws 403 — not a member of the org
 */
export async function gethugs_unanswered(
    input: { user_id: string; org_id: string; limit?: number },
    opts: { partner?: GethugsPartner; now?: number } = {},
): Promise<Unanswered> {
    const limit = Math.min(Math.max(input.limit ?? 5, 1), MAX_LIMIT);
    const [member] = await get_sequelize().query<{ user_id: string }>(
        `SELECT user_id FROM cliq.org_members WHERE org_id = :org_id AND user_id = :user_id AND status = 'active' AND deleted_at IS NULL`,
        { replacements: { org_id: input.org_id, user_id: input.user_id }, type: QueryTypes.SELECT },
    );
    if (!member) throw ApiError.forbidden('Not a member of this org');

    const [g_org, g_user] = await Promise.all([linked(input.org_id, 'org', input.org_id), linked(input.org_id, 'user', input.user_id)]);
    if (!g_org || !g_user) return { total: 0, items: [], in_gethugs: false };

    const now = opts.now ?? Date.now();
    const k = key(input.org_id, input.user_id);
    const hit = cache.get(k);
    if (hit && hit.g_org === g_org && now - hit.at < TTL_MS && hit.limit >= limit) {
        return { ...hit.value, items: hit.value.items.slice(0, limit) };
    }
    try {
        const page = await (opts.partner ?? gethugs_partner()).site.call<{ items: UnansweredHug[]; total?: number }>('hugs/get', {
            org_id: g_org, user_id: g_user, unanswered: true, with_total: true, limit,
        });
        const items = page.items;
        const value: Unanswered = { total: page.total ?? items.length, items, in_gethugs: true };
        cache.set(k, { at: now, g_org, value, limit });
        return value;
    } catch (err) {
        log.warn('gethugs_unanswered_failed', { org_id: input.org_id, user_id: input.user_id, error: err instanceof Error ? err.message : String(err) });
        if (hit) return { ...hit.value, items: hit.value.items.slice(0, limit), stale: true };
        return { total: null, items: [], in_gethugs: true };
    }
}
