/**
 * The Hugs a person can answer — their inbox list and the badge counts (PLAN-hug-requests §6.3).
 *
 * A person can answer a Hug addressed to them (their own channel, or a shared channel) in a realm
 * where they have `runs.view` — the same rule `hugs/respond` applies. What's waiting on a person (the
 * badge, realm cards, the dashboard's list) leaves out Hugs they've already answered: a Hug that
 * waits on several people stays open after one of them responds.
 */

import { Op, literal } from 'sequelize';

import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';
import { get_sequelize } from '../db/sequelize.js';
import { Hug, HugResponse } from '../models/index.js';
import { visible_realm_ids } from '../auth/route_policy/visible.js';
import { load_realm_info_map, load_run_info_map, resolve_team } from './hug_enrichment.js';
import { hug_url_for } from './hugs.service.js';

const log = get_logger('svc.hug_pending');

/** One row of a person's Hug list. */
export interface HugListItem {
    hug_id: string;
    hug_url: string;
    title: string;
    realm_id: string;
    realm_name: string | null;
    realm_slug: string | null;
    org_slug: string | null;
    run_id: string;
    run_name: string | null;
    team: string | null;
    phase: string;
    status: string;
    /** Whether this person has already responded. */
    responded: boolean;
    /** Epoch ms. */
    created_at: number;
    expires_at: number;
    closed_at: number | null;
    last_reminded_at: number | null;
}

/** The Hugs a person can answer. */
export class HugPendingService {
    /** A person's Hugs, newest first (default: open ones; `unanswered`: only those they haven't responded to). */
    static async list_for_user(opts: {
        user_id: string;
        realm_id?: string;
        org_id?: string;
        statuses?: string[];
        unanswered?: boolean;
        limit?: number;
        offset?: number;
    }): Promise<{ hugs: HugListItem[]; total: number }> {
        const user_id = opts.user_id.trim();
        if (!user_id) throw ApiError.unauthorized('Authentication required');
        log.debug('list_for_user', { user_id, realm_id: opts.realm_id, org_id: opts.org_id });

        const limit = Math.min(Math.max(1, opts.limit ?? 50), 100);
        const offset = Math.max(0, opts.offset ?? 0);
        const where = await reachable_where(user_id, {
            status: { [Op.in]: opts.statuses?.length ? opts.statuses : ['open'] },
            ...(opts.realm_id?.trim() ? { realm_id: opts.realm_id.trim() } : {}),
            ...(opts.org_id ? { org_id: opts.org_id } : {}),
        }, { unanswered: opts.unanswered === true });
        if (!where) return { hugs: [], total: 0 };

        const [total, rows] = await Promise.all([
            Hug.count({ where }),
            Hug.findAll({ where, order: [['created_at', 'DESC']], limit, offset }),
        ]);
        const [runs, realms, mine] = await Promise.all([
            load_run_info_map(rows.map((r) => r.run_id)),
            load_realm_info_map(rows.map((r) => r.realm_id)),
            HugResponse.findAll({ where: { hug_id: { [Op.in]: rows.map((r) => r.id) }, responder_user_id: user_id }, attributes: ['hug_id'], raw: true }),
        ]);
        const responded = new Set(mine.map((m) => m.hug_id));
        return {
            total,
            hugs: rows.map((row) => {
                const run = runs.get(row.run_id);
                const realm = realms.get(row.realm_id);
                return {
                    hug_id: row.id,
                    hug_url: hug_url_for(row.id),
                    title: row.title,
                    realm_id: row.realm_id,
                    realm_name: realm?.realm_name ?? null,
                    realm_slug: realm?.realm_slug ?? null,
                    org_slug: realm?.org_slug ?? null,
                    run_id: row.run_id,
                    run_name: run?.run_name ?? null,
                    team: resolve_team(run),
                    phase: row.phase,
                    status: row.status,
                    responded: responded.has(row.id),
                    created_at: row.created_at.getTime(),
                    expires_at: row.expires_at.getTime(),
                    closed_at: row.closed_at ? row.closed_at.getTime() : null,
                    last_reminded_at: row.last_reminded_at ? row.last_reminded_at.getTime() : null,
                };
            }),
        };
    }

    /** How many open Hugs are waiting on a person — addressed to them, not yet answered by them (sidebar badge). */
    static async count_open_for_user(opts: { user_id: string; org_id?: string }): Promise<number> {
        const user_id = opts.user_id.trim();
        if (!user_id) return 0;
        const where = await reachable_where(user_id, { status: 'open', ...(opts.org_id ? { org_id: opts.org_id } : {}) }, { unanswered: true });
        return where ? Hug.count({ where }) : 0;
    }

    /** {@link count_open_for_user} per realm — realm cards show the same number as the list. */
    static async count_open_by_realm_for_user(opts: { user_id: string; realm_ids: string[] }): Promise<Map<string, number>> {
        const counts = new Map<string, number>();
        const user_id = opts.user_id.trim();
        if (!user_id || opts.realm_ids.length === 0) return counts;
        const where = await reachable_where(user_id, { status: 'open', realm_id: { [Op.in]: opts.realm_ids } }, { unanswered: true });
        if (!where) return counts;
        const rows = await Hug.findAll({ where, attributes: ['realm_id'], raw: true });
        for (const row of rows) counts.set(row.realm_id, (counts.get(row.realm_id) ?? 0) + 1);
        return counts;
    }
}

/**
 * `where` for Hugs addressed to `user_id` (their own channel, or a shared channel) in realms where
 * they have `runs.view`, combined with `extra`; with `unanswered`, not those they've responded to.
 * Null when nothing can match.
 */
async function reachable_where(
    user_id: string,
    extra: Record<string | symbol, unknown>,
    opts: { unanswered?: boolean } = {},
): Promise<Record<string | symbol, unknown> | null> {
    const realm_ids = await visible_realm_ids(user_id, { perm: 'runs.view' });
    if (realm_ids.length === 0) return null;
    const user = get_sequelize().escape(user_id);
    const addressed = literal(`(SELECT "hug_id" FROM cliq."hug_deliveries" WHERE "user_id" IS NULL OR "user_id" = ${user})`);
    const conditions: Array<Record<string | symbol, unknown>> = [{ id: { [Op.in]: addressed } }, { realm_id: { [Op.in]: realm_ids } }];
    if (opts.unanswered) {
        conditions.push({ id: { [Op.notIn]: literal(`(SELECT "hug_id" FROM cliq."hug_responses" WHERE "responder_user_id" = ${user})`) } });
    }
    return { ...extra, [Op.and]: conditions };
}
