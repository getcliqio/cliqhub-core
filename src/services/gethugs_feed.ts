/**
 * The getHugs feed reader (PLAN-gethugs-step4-answers.md): one per cliqhub (an advisory lock), it long-polls getHugs'
 * partner event feed and applies each event of a Hug Core has a row for ({@link gethugs_apply}), then saves the cursor.
 * Applying is idempotent (getHugs' seq per Hug), so a restart that re-reads a page delivers nothing twice.
 *
 * Catch-up, so nothing is missed: with no cursor yet or after `cursor_expired` (events are kept 7 days), the feed
 * starts from now and every open getHugs Hug of Core's re-reads its own events (`hugs/get_events`); a Hug answered
 * before Core stored its row is caught up right after create ({@link gethugs_catch_up}).
 */

import { HugsError } from '@gethugs/client';
import { Op, QueryTypes } from 'sequelize';

import { get_sequelize } from '../db/sequelize.js';
import { get_logger } from '../lib/log.js';
import { Hug } from '../models/index.js';
import { gethugs_partner, type GethugsPartner } from './gethugs.service.js';
import { gethugs_apply, type GethugsEvent } from './gethugs_events.js';

const log = get_logger('svc.gethugs_feed');

export const GETHUGS_FEED_LOCK_KEY = 0x6e7469;
const CURSOR_KEY = 'gethugs.feed_cursor';
const WAIT_S = 30;
const IDLE_MS = 30_000;
const BACKOFF_MS = [5_000, 15_000, 60_000];

interface LockConnection {
    query(sql: string, params: unknown[]): Promise<{ rows: Array<{ locked?: boolean }> }>;
}
interface FeedPage { events: GethugsEvent[]; cursor: string; has_more: boolean }
interface HugEvents { events: Array<{ hug_id: string; seq: number; type: 'response' | 'expired' | 'cancelled'; payload: Record<string, unknown> }>; has_more: boolean }

async function load_cursor(): Promise<string | null> {
    const [row] = await get_sequelize().query<{ value: string }>('SELECT value FROM cliq.settings WHERE key = :key', { replacements: { key: CURSOR_KEY }, type: QueryTypes.SELECT });
    return row?.value || null;
}

async function save_cursor(cursor: string): Promise<void> {
    await get_sequelize().query(
        `INSERT INTO cliq.settings (key, value, updated_at) VALUES (:key, :cursor, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        { replacements: { key: CURSOR_KEY, cursor } },
    );
}

const is_cursor_expired = (err: unknown) => err instanceof HugsError && err.details?.code === 'cursor_expired';

/** One of getHugs' per-Hug events as the feed would carry it. */
function as_feed_event(gethugs_id: string, e: HugEvents['events'][number]): GethugsEvent {
    if (e.type === 'response') return { type: 'hug.responded', hug: { id: gethugs_id }, seq: e.seq, response: e.payload.response as GethugsEvent['response'] };
    return { type: e.type === 'expired' ? 'hug.expired' : 'hug.cancelled', hug: { id: gethugs_id }, seq: e.seq, reason: (e.payload.reason as string | undefined) ?? null };
}

/**
 * Applies the getHugs events of these Hugs after each one's `gethugs_seq` (`hugs/get_events`, one workspace at a time).
 *
 * @returns how many events were applied
 */
async function catch_up(partner: GethugsPartner, hugs: Array<Pick<Hug, 'org_id' | 'gethugs_id' | 'gethugs_workspace_id' | 'gethugs_seq'>>): Promise<number> {
    const by_workspace = new Map<string, typeof hugs>();
    for (const h of hugs) {
        if (!h.gethugs_id || !h.gethugs_workspace_id) continue;
        by_workspace.set(h.gethugs_workspace_id, [...(by_workspace.get(h.gethugs_workspace_id) ?? []), h]);
    }
    let applied = 0;
    for (const [workspace_id, list] of by_workspace) {
        const [org] = await get_sequelize().query<{ gethugs_id: string }>(
            `SELECT gethugs_id FROM cliq.gethugs_links WHERE org_id = :org_id AND kind = 'org' LIMIT 1`,
            { replacements: { org_id: list[0]!.org_id }, type: QueryTypes.SELECT },
        );
        if (!org) continue;
        const after = new Map(list.map((h) => [h.gethugs_id!, h.gethugs_seq]));
        for (let i = 0; i < list.length; i += 500) {
            let more = true;
            while (more) {
                const cursors = list.slice(i, i + 500).map((h) => ({ hug_id: h.gethugs_id!, after_seq: after.get(h.gethugs_id!) ?? 0 }));
                const page = await partner.site.call<HugEvents>('hugs/get_events', { org_id: org.gethugs_id, workspace_id, cursors });
                for (const e of page.events) {
                    if (await gethugs_apply(as_feed_event(e.hug_id, e))) applied += 1;
                    after.set(e.hug_id, Math.max(after.get(e.hug_id) ?? 0, e.seq));
                }
                more = page.has_more && page.events.length > 0;
            }
        }
    }
    return applied;
}

/** Re-reads every open getHugs Hug's events: the feed's start, and after `cursor_expired`. */
async function recover(partner: GethugsPartner): Promise<number> {
    const open = await Hug.findAll({ where: { provider: 'gethugs', status: 'open', gethugs_id: { [Op.ne]: null } }, attributes: ['org_id', 'gethugs_id', 'gethugs_workspace_id', 'gethugs_seq'], raw: true });
    const applied = await catch_up(partner, open);
    log.info('gethugs_feed_recovered', { open: open.length, applied });
    return applied;
}

/** A new Hug's events so far — what the feed skipped while Core had no row for it. Best effort. */
export async function gethugs_catch_up(hug_id: string, partner: GethugsPartner | null = gethugs_partner()): Promise<void> {
    if (!partner) return;
    try {
        const hug = await Hug.findByPk(hug_id, { attributes: ['org_id', 'gethugs_id', 'gethugs_workspace_id', 'gethugs_seq'], raw: true });
        if (hug) await catch_up(partner, [hug]);
    } catch (err) {
        log.warn('gethugs_catch_up_failed', { hug_id, error: err instanceof Error ? err.message : String(err) });
    }
}

export interface FeedRunResult {
    /** False when another process holds the reader's lock. */
    ran: boolean;
    applied: number;
    recovered: boolean;
}

/**
 * Reads the feed once — one page, or waits up to `wait_s` for one — unless another process is the reader.
 * With no cursor (or an expired one) it starts from now and recovers first.
 */
export async function run_gethugs_feed(partner: GethugsPartner, opts: { wait_s?: number } = {}): Promise<FeedRunResult> {
    const result: FeedRunResult = { ran: false, applied: 0, recovered: false };
    const manager = get_sequelize().connectionManager;
    const connection = await manager.getConnection({ type: 'write' }) as unknown as LockConnection;
    try {
        const { rows } = await connection.query('SELECT pg_try_advisory_lock($1) AS locked', [GETHUGS_FEED_LOCK_KEY]);
        if (!rows[0]?.locked) return result;
        try {
            result.ran = true;
            let cursor = await load_cursor();
            const start_over = async () => {
                // The feed's end first, then the open Hugs: anything in between comes twice and is applied once.
                const { cursor: fresh } = await partner.site.events.get();
                await save_cursor(fresh);
                result.applied += await recover(partner);
                result.recovered = true;
                return fresh;
            };
            if (!cursor) cursor = await start_over();
            let page: FeedPage;
            try {
                page = (opts.wait_s ?? WAIT_S) > 0
                    ? await partner.site.events.wait(cursor, { timeout_s: opts.wait_s ?? WAIT_S }) as unknown as FeedPage
                    : await partner.site.events.get({ cursor }) as unknown as FeedPage;
            } catch (err) {
                if (!is_cursor_expired(err)) throw err;
                log.warn('gethugs_feed_cursor_expired', {});
                await start_over();
                return result;
            }
            for (const event of page.events) {
                if (await gethugs_apply(event)) result.applied += 1;
            }
            await save_cursor(page.cursor);
            return result;
        } finally {
            await connection.query('SELECT pg_advisory_unlock($1)', [GETHUGS_FEED_LOCK_KEY]);
        }
    } finally {
        await manager.releaseConnection(connection as never);
    }
}

let _running = false;

/** Starts the feed reader loop (one reads; the others wait their turn). Does nothing when getHugs isn't configured. */
export function start_gethugs_feed(): void {
    if (_running) return;
    const partner = gethugs_partner();
    if (!partner) return;
    _running = true;
    void (async () => {
        let failures = 0;
        while (_running) {
            try {
                const run = await run_gethugs_feed(partner);
                failures = 0;
                if (!run.ran) await new Promise((r) => setTimeout(r, IDLE_MS).unref());
            } catch (err) {
                const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!;
                failures += 1;
                log.warn('gethugs_feed_failed', { error: err instanceof Error ? err.message : String(err), retry_in_ms: wait });
                await new Promise((r) => setTimeout(r, wait).unref());
            }
        }
    })();
}

/** Stops the reader loop after its current read (graceful shutdown). */
export function stop_gethugs_feed(): void {
    _running = false;
}
