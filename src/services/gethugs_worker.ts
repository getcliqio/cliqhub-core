/**
 * The getHugs sync worker (PLAN-gethugs-step2-provisioning.md, sub-step 4). In every Core process, every 30 s, one
 * process at a time (an advisory lock, like the invite sweep):
 *
 * - **nightly** (the first run after 03:00 UTC each day): marks every switched org, so a missed hook or a bulk write is
 *   repaired within a day;
 * - reconciles each org that is switched (`hugs_provider = 'gethugs'`) or switching (`state = 'switching'`), marked
 *   since its last sync and due (`next_try_at`), oldest mark first. A reconcile that throws backs off (1 min doubling
 *   to 1 h) with `last_error`; one that finishes is `synced_at` its start (a mark made meanwhile is seen next time),
 *   with what getHugs refused in `report` — and a switching org is switched on.
 *
 * Marks on orgs that aren't switched are ignored. Nothing runs when getHugs isn't configured.
 */

import { QueryTypes } from 'sequelize';

import { get_sequelize } from '../db/sequelize.js';
import { get_logger } from '../lib/log.js';
import { gethugs_partner, type GethugsPartner } from './gethugs.service.js';
import { gethugs_reconcile, type Refusal } from './gethugs_reconcile.js';
import { gethugs_mark } from './gethugs_sync.js';

const log = get_logger('gethugs_worker');

export const GETHUGS_SYNC_LOCK_KEY = 0x6e7468;
export const GETHUGS_SYNC_INTERVAL_MS = 30_000;
const BATCH = 20;
const BACKOFF_FIRST_S = 60;
const BACKOFF_MAX_S = 3600;
const NIGHTLY_HOUR_UTC = 3;
const NIGHTLY_KEY = 'gethugs.nightly_on';

let _timer: ReturnType<typeof setInterval> | null = null;

interface LockConnection {
    query(sql: string, params: unknown[]): Promise<{ rows: Array<{ locked?: boolean }> }>;
}

export interface GethugsSyncResult {
    /** False when getHugs isn't configured or another process holds the lock. */
    ran: boolean;
    /** Orgs marked by the nightly pass (0 when it didn't run). */
    nightly: number;
    synced: string[];
    failed: string[];
    /** Orgs switched on by this run. */
    switched: string[];
}

/** The seconds to wait after the `attempts`-th failure in a row: 1 min, doubling, at most 1 h. */
export function backoff_s(attempts: number): number {
    return Math.min(BACKOFF_FIRST_S * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_S);
}

/**
 * Runs the worker once at `now`, unless getHugs isn't configured or another process holds the lock.
 *
 * @param now - The run's clock (tests pass a fake one).
 * @param partner - cliqhub's partner at getHugs (tests pass one with a fake getHugs).
 */
export async function run_gethugs_sync(now: Date = new Date(), partner: GethugsPartner | null = gethugs_partner()): Promise<GethugsSyncResult> {
    const result: GethugsSyncResult = { ran: false, nightly: 0, synced: [], failed: [], switched: [] };
    if (!partner) return result;
    const manager = get_sequelize().connectionManager;
    const connection = await manager.getConnection({ type: 'write' }) as unknown as LockConnection;
    try {
        const { rows } = await connection.query('SELECT pg_try_advisory_lock($1) AS locked', [GETHUGS_SYNC_LOCK_KEY]);
        if (!rows[0]?.locked) {
            log.debug('gethugs_sync_skipped', { reason: 'locked' });
            return result;
        }
        try {
            result.ran = true;
            result.nightly = await nightly(now);
            await sync_due(now, partner, result);
            if (result.synced.length || result.failed.length || result.nightly) log.info('gethugs_sync', { ...result, synced: result.synced.length, failed: result.failed.length });
            return result;
        } finally {
            await connection.query('SELECT pg_advisory_unlock($1)', [GETHUGS_SYNC_LOCK_KEY]);
        }
    } finally {
        await manager.releaseConnection(connection as never);
    }
}

/** Marks every switched org, once a day after 03:00 UTC. */
async function nightly(now: Date): Promise<number> {
    if (now.getUTCHours() < NIGHTLY_HOUR_UTC) return 0;
    const today = now.toISOString().slice(0, 10);
    const sq = get_sequelize();
    const [done] = await sq.query<{ value: string }>('SELECT value FROM cliq.settings WHERE key = :key', { replacements: { key: NIGHTLY_KEY }, type: QueryTypes.SELECT });
    if (done?.value === today) return 0;
    const orgs = await sq.query<{ id: string }>(`SELECT id FROM cliq.orgs WHERE hugs_provider = 'gethugs'`, { type: QueryTypes.SELECT });
    await gethugs_mark(orgs.map((o) => o.id));
    await sq.query(
        `INSERT INTO cliq.settings (key, value, updated_at) VALUES (:key, :today, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        { replacements: { key: NIGHTLY_KEY, today } },
    );
    return orgs.length;
}

async function sync_due(now: Date, partner: GethugsPartner, result: GethugsSyncResult): Promise<void> {
    const sq = get_sequelize();
    const due = await sq.query<{ org_id: string; state: string; attempts: number }>(
        `SELECT s.org_id, s.state, s.attempts FROM cliq.gethugs_sync s JOIN cliq.orgs o ON o.id = s.org_id
         WHERE (o.hugs_provider = 'gethugs' OR s.state = 'switching')
           AND (s.synced_at IS NULL OR s.marked_at > s.synced_at)
           AND s.next_try_at <= :now
         ORDER BY s.marked_at LIMIT ${BATCH}`,
        { replacements: { now }, type: QueryTypes.SELECT },
    );
    for (const row of due) {
        const [{ started }] = await sq.query<{ started: Date }>('SELECT clock_timestamp() AS started', { type: QueryTypes.SELECT });
        let report: Refusal[];
        try {
            report = (await gethugs_reconcile(row.org_id, partner)).report;
        } catch (err) {
            const attempts = row.attempts + 1;
            const message = err instanceof Error ? err.message : String(err);
            await sq.query(
                `UPDATE cliq.gethugs_sync SET attempts = :attempts, last_error = :message, next_try_at = :next WHERE org_id = :org_id`,
                { replacements: { attempts, message: message.slice(0, 2000), next: new Date(now.getTime() + backoff_s(attempts) * 1000), org_id: row.org_id } },
            );
            log.warn('gethugs_reconcile_failed', { org_id: row.org_id, attempts, error: message });
            result.failed.push(row.org_id);
            continue;
        }
        await sq.transaction(async (t) => {
            await sq.query(
                `UPDATE cliq.gethugs_sync SET synced_at = :started, attempts = 0, last_error = NULL, next_try_at = :now, report = CAST(:report AS jsonb), state = 'idle'
                 WHERE org_id = :org_id`,
                { replacements: { started, now, report: JSON.stringify(report), org_id: row.org_id }, transaction: t },
            );
            if (row.state === 'switching') {
                await sq.query(`UPDATE cliq.orgs SET hugs_provider = 'gethugs' WHERE id = :org_id`, { replacements: { org_id: row.org_id }, transaction: t });
            }
        });
        result.synced.push(row.org_id);
        if (row.state === 'switching') {
            result.switched.push(row.org_id);
            log.info('gethugs_switched_on', { org_id: row.org_id, refused: report.length });
        }
    }
}

/**
 * Starts switching an org to getHugs: the worker reconciles it and switches it on when a reconcile finishes.
 * Already switched: marks it (a fresh reconcile).
 */
export async function gethugs_switch_on(org_id: string): Promise<void> {
    await get_sequelize().query(
        `INSERT INTO cliq.gethugs_sync (org_id, marked_at, next_try_at, attempts, state)
         SELECT id, clock_timestamp(), now(), 0, CASE WHEN hugs_provider = 'gethugs' THEN 'idle' ELSE 'switching' END FROM cliq.orgs WHERE id = :org_id
         ON CONFLICT (org_id) DO UPDATE SET marked_at = EXCLUDED.marked_at, next_try_at = now(), attempts = 0, state = EXCLUDED.state`,
        { replacements: { org_id } },
    );
}

/** Switches an org back to cliqhub's own Hugs (Hugs already in getHugs stay there) and stops switching it. */
export async function gethugs_switch_off(org_id: string): Promise<void> {
    const sq = get_sequelize();
    await sq.transaction(async (t) => {
        await sq.query(`UPDATE cliq.orgs SET hugs_provider = 'cliqhub' WHERE id = :org_id`, { replacements: { org_id }, transaction: t });
        await sq.query(`UPDATE cliq.gethugs_sync SET state = 'idle' WHERE org_id = :org_id`, { replacements: { org_id }, transaction: t });
    });
}

function run_logged(): void {
    run_gethugs_sync().catch((err) => {
        log.error('gethugs_sync_failed', { error: err instanceof Error ? err.message : String(err) });
    });
}

/** Starts the worker (runs once right away). Does nothing when getHugs isn't configured. */
export function start_gethugs_worker(): void {
    if (_timer) return;
    if (!gethugs_partner()) {
        log.info('gethugs_worker_off', { reason: 'not_configured' });
        return;
    }
    run_logged();
    _timer = setInterval(run_logged, GETHUGS_SYNC_INTERVAL_MS);
    _timer.unref();
}

/** Stops the worker (graceful shutdown). */
export function stop_gethugs_worker(): void {
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}
