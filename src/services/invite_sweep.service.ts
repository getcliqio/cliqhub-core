/**
 * Invite sweep: a timer inside Core that, every `INVITE_SWEEP_INTERVAL_MS`
 * (config/identity_lifecycle.ts):
 *
 *   1. sends reminders for pending invites 3 days and 1 day before they expire
 *      (`invite.<kind>.reminder`, same link; `reminders_sent` makes each one
 *      go out once);
 *   2. expires pending invites past their expiry (`invite.<kind>.expired`) and
 *      removes their pending membership;
 *   3. when an owner invite expires and its org has no active member,
 *      soft-deletes the org and the never-activated invited owner (when no
 *      other invite is open for them) the way orgs/delete and users/delete
 *      do (namespace_removal.ts) and raises `org.abandoned`.
 *
 * A session-level Postgres advisory lock, held on one dedicated connection for
 * the run, makes only one Core instance sweep at a time; no transaction stays
 * open across the run. Each invite is handled in its own short transaction
 * whose writes are conditional on the invite still being what the sweep read
 * (a "send again" in between wins), and its events go out after commit.
 * Started and stopped with the server like the review expiry sweep; tests
 * call {@link run_invite_sweep} with their own clock.
 */

import { Op, type Transaction } from 'sequelize';

import { INVITE_REMINDER_OFFSETS_MS, INVITE_SWEEP_BATCH, INVITE_SWEEP_INTERVAL_MS } from '../config/identity_lifecycle.js';
import { get_sequelize } from '../db/sequelize.js';
import { get_logger } from '../lib/log.js';
import { AccountInvite, OrgMember, RealmInvite, User } from '../models/index.js';
import { ORG_ABANDONED, invite_event } from '../notifications/org_events.js';
import { OrgEventService } from './org_event.service.js';
import {
    drop_pending_membership, invite_event_data, invite_link, invite_model, load_context, to_record, type InviteTable,
} from './invite_records.js';
import { invite_kind, reminder_due } from './invite_rules.js';
import { soft_delete_org, soft_delete_user } from './namespace_removal.js';
import { RealmService } from './realm.service.js';

const log = get_logger('svc.invite_sweep');

/** Postgres advisory lock key of the invite sweep (any constant unique to this job). */
export const INVITE_SWEEP_LOCK_KEY = 0x1d17e5;

const TABLES: readonly InviteTable[] = ['account_invites', 'realm_invites'];

let _timer: ReturnType<typeof setInterval> | null = null;

/** What one sweep run did. */
export interface InviteSweepResult {
    /** False when another instance held the lock. */
    ran: boolean;
    reminders: number;
    expired: number;
    abandoned: number;
}

/** The pg client behind a pooled Sequelize connection (only `query` is used). */
type LockConnection = { query: (text: string, values: unknown[]) => Promise<{ rows: Array<{ locked?: boolean }> }> };

/**
 * Sends due reminders (each at most once) and returns how many went out. A
 * reminder is claimed with a write pinned on the invite's status, expiry and
 * reminder count as read, so an invite sent again in the meantime (new
 * expiry, count back to 0) is left for its own reminders.
 */
async function send_reminders(now: Date): Promise<number> {
    const horizon = new Date(now.getTime() + Math.max(...INVITE_REMINDER_OFFSETS_MS));
    let sent = 0;
    for (const table of TABLES) {
        const model = invite_model(table);
        const rows = await model.findAll({
            where: {
                status: 'pending',
                expires_at: { [Op.gt]: now, [Op.lte]: horizon },
                reminders_sent: { [Op.lt]: INVITE_REMINDER_OFFSETS_MS.length },
            },
            order: [['expires_at', 'ASC']],
            limit: INVITE_SWEEP_BATCH,
            raw: true,
        });
        for (const row of rows) {
            const due = reminder_due(row, now);
            if (!due) continue;
            try {
                const [claimed] = await model.update(
                    { reminders_sent: due.reminders_sent },
                    { where: { id: row.id, status: 'pending', expires_at: row.expires_at, reminders_sent: row.reminders_sent } },
                );
                if (claimed !== 1) continue;
                const invite = await to_record(table, row as never);
                if (!invite) continue;
                const ctx = await load_context(invite);
                if (ctx.org.status === 'deleted') continue;
                await OrgEventService.raise({
                    event: invite_event(invite_kind(invite.target, invite.role), 'reminder'),
                    org_id: invite.org_id,
                    realm_id: invite.realm_id,
                    actor: { system: 'sweep' },
                    data: invite_event_data(invite, ctx),
                    link: invite_link(invite),
                    occurred_at: now.toISOString(),
                });
                sent += 1;
            } catch (err) {
                log.error('invite_reminder_failed', { table, invite_id: row.id, error: err instanceof Error ? err.message : String(err) });
            }
        }
    }
    return sent;
}

/** True when the invited person has another open invite (any org or realm) besides `invite_id`. */
async function has_other_open_invite(email: string, invite_id: string, now: Date, t: Transaction): Promise<boolean> {
    const where = { email, status: 'pending', id: { [Op.ne]: invite_id }, expires_at: { [Op.gt]: now } };
    const [org_invites, realm_invites] = await Promise.all([
        AccountInvite.count({ where, transaction: t }),
        RealmInvite.count({ where, transaction: t }),
    ]);
    return org_invites + realm_invites > 0;
}

/**
 * Whether the org of an expired owner invite is abandoned: nobody is an
 * active member and no other owner invite is still open.
 */
async function org_abandoned(org_id: string, invite_id: string, now: Date, t: Transaction): Promise<boolean> {
    const active = await OrgMember.count({ where: { org_id, status: 'active', deleted_at: null }, transaction: t });
    if (active > 0) return false;
    const open_owner_invites = await AccountInvite.count({
        where: { org_id, role: 'owner', status: 'pending', id: { [Op.ne]: invite_id }, expires_at: { [Op.gt]: now } },
        transaction: t,
    });
    return open_owner_invites === 0;
}

/** What expiring one invite did. */
type ExpireOutcome =
    | { expired: false }
    | { expired: true; abandoned: false }
    | { expired: true; abandoned: true; realms: Array<{ id: string; slug: string }>; actor_id: string };

/**
 * Expires one invite in its own transaction, unless it was sent again since
 * it was read (the write is pinned on `status` and `expires_at <= now`).
 * Abandons the org when it was an owner invite and the org has no active
 * member and no other open owner invite.
 */
async function expire_one(table: InviteTable, row: { id: string }, now: Date): Promise<ExpireOutcome> {
    const model = invite_model(table);
    return get_sequelize().transaction(async (t): Promise<ExpireOutcome> => {
        const [count] = await model.update(
            { status: 'expired' },
            { where: { id: row.id, status: 'pending', expires_at: { [Op.lte]: now } }, transaction: t },
        );
        if (count !== 1) return { expired: false };
        const fresh = await model.findByPk(row.id, { raw: true, transaction: t });
        const invite = fresh ? await to_record(table, fresh as never, t) : null;
        if (!invite) return { expired: true, abandoned: false };
        await drop_pending_membership(invite, now, t);
        const ctx = await load_context(invite, t);
        const kind = invite_kind(invite.target, invite.role);
        OrgEventService.raise_after_commit(t, {
            event: invite_event(kind, 'expired'),
            org_id: invite.org_id,
            realm_id: invite.realm_id,
            actor: { system: 'sweep' },
            data: invite_event_data(invite, ctx),
            occurred_at: now.toISOString(),
        });
        if (kind !== 'owner' || ctx.org.status === 'deleted') return { expired: true, abandoned: false };
        if (!(await org_abandoned(invite.org_id, invite.id, now, t))) return { expired: true, abandoned: false };

        const realms = await soft_delete_org({ id: invite.org_id }, t, now);
        const owner = await User.findOne({
            where: { email: invite.email, status: 'invited', deleted_at: null }, attributes: ['id', 'username'], raw: true, transaction: t,
        });
        if (owner && !(await has_other_open_invite(invite.email, invite.id, now, t))) {
            const removed = await soft_delete_user({ id: String(owner.id), username: owner.username ?? null }, t, now);
            realms.push(...removed.realms);
        }
        OrgEventService.raise_after_commit(t, {
            event: ORG_ABANDONED,
            org_id: invite.org_id,
            actor: { system: 'sweep' },
            data: {
                org: { id: ctx.org.id, slug: ctx.org.slug, display_name: ctx.org.display_name },
                invite_id: invite.id,
                invitee_email: invite.email,
                inviter: ctx.inviter,
                expired_at: invite.expires_at.toISOString(),
            },
            occurred_at: now.toISOString(),
        });
        // The sweep has no user: realm cleanup is attributed to the inviter.
        return { expired: true, abandoned: true, realms, actor_id: ctx.inviter.id };
    });
}

/** Expires pending invites past their expiry; abandons orgs whose owner never came. */
async function expire_invites(now: Date): Promise<{ expired: number; abandoned: number }> {
    let expired = 0;
    let abandoned = 0;
    for (const table of TABLES) {
        const rows = await invite_model(table).findAll({
            where: { status: 'pending', expires_at: { [Op.lte]: now } },
            attributes: ['id'],
            order: [['expires_at', 'ASC']],
            limit: INVITE_SWEEP_BATCH,
            raw: true,
        });
        for (const row of rows) {
            try {
                const outcome = await expire_one(table, row, now);
                if (!outcome.expired) continue;
                expired += 1;
                if (outcome.abandoned) {
                    abandoned += 1;
                    await RealmService.after_org_realms_removed(outcome.realms, outcome.actor_id);
                    log.info('org_abandoned', { invite_id: row.id });
                }
            } catch (err) {
                log.error('invite_expire_failed', { table, invite_id: row.id, error: err instanceof Error ? err.message : String(err) });
            }
        }
    }
    return { expired, abandoned };
}

/**
 * Runs one sweep at `now`, unless another instance holds the sweep lock.
 *
 * @param now - The sweep's clock (tests pass a fake one).
 */
export async function run_invite_sweep(now: Date = new Date()): Promise<InviteSweepResult> {
    const manager = get_sequelize().connectionManager;
    const connection = await manager.getConnection({ type: 'write' }) as unknown as LockConnection;
    try {
        const { rows } = await connection.query('SELECT pg_try_advisory_lock($1) AS locked', [INVITE_SWEEP_LOCK_KEY]);
        if (!rows[0]?.locked) {
            log.debug('invite_sweep_skipped', { reason: 'locked' });
            return { ran: false, reminders: 0, expired: 0, abandoned: 0 };
        }
        try {
            const reminders = await send_reminders(now);
            const { expired, abandoned } = await expire_invites(now);
            if (reminders || expired) log.info('invite_sweep', { reminders, expired, abandoned });
            return { ran: true, reminders, expired, abandoned };
        } finally {
            await connection.query('SELECT pg_advisory_unlock($1)', [INVITE_SWEEP_LOCK_KEY]);
        }
    } finally {
        await manager.releaseConnection(connection as never);
    }
}

function run_logged(): void {
    run_invite_sweep().catch((err) => {
        log.error('invite_sweep_failed', { error: err instanceof Error ? err.message : String(err) });
    });
}

/** Starts the periodic invite sweep (runs once right away). */
export function start_invite_sweep(): void {
    log.debug('start_invite_sweep', {});
    if (_timer) return;
    run_logged();
    _timer = setInterval(run_logged, INVITE_SWEEP_INTERVAL_MS);
    _timer.unref();
}

/** Stops the invite sweep (graceful shutdown). */
export function stop_invite_sweep(): void {
    log.debug('stop_invite_sweep', {});
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
}
