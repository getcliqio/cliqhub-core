/**
 * getHugs' events, applied to Core's Hugs (PLAN-gethugs-step4-answers.md): what happens to a switched org's Hug in
 * getHugs reaches the daemon that asked as Core's own events do — a `response`, `expired` or `cancelled` event with
 * Core's next `seq`, delivered through the command outbox.
 *
 * One rule makes every path safe: an event of getHugs' seq `s` is applied only when `s > hugs.gethugs_seq`, and
 * applying it sets `gethugs_seq` in the same transaction. The feed, the catch-up after create and the recovery can all
 * bring the same event; it is applied once.
 */

import { QueryTypes, type Transaction } from 'sequelize';

import { get_sequelize } from '../db/sequelize.js';
import { get_logger } from '../lib/log.js';
import { Hug } from '../models/index.js';
import { EXTERNAL_SOURCE } from './gethugs_reconcile.js';
import { HugsService } from './hugs.service.js';

const log = get_logger('svc.gethugs_events');

/** A getHugs Hug event, as the partner feed carries it (`hugs/get_events` carries the same per Hug). */
export interface GethugsEvent {
    type: string;
    hug: { id: string };
    /** getHugs' own event number of the Hug (responded, expired, cancelled); null for the others. */
    seq: number | null;
    response?: {
        response_id: string;
        responder: { user_id: string; name: string | null; external?: { source: string; id: string } | null };
        via?: string[];
        values: Record<string, unknown>;
        summary?: string | null;
        responded_at: number | string;
    };
    outcome?: string | null;
    reason?: string | null;
}

/** The cliq user a getHugs person mirrors (their reference `cliqhub` `user:<id>`), with the name cliq shows. */
async function responder_of(r: NonNullable<GethugsEvent['response']>['responder'], t: Transaction): Promise<{ user_id: string; name: string }> {
    let ref = r.external?.source === EXTERNAL_SOURCE && r.external.id.startsWith('user:') ? r.external.id.slice(5) : null;
    if (!ref) {
        // A Hug's own events (`hugs/get_events`, the catch-up) name the person by getHugs' id only: the sync's links.
        const [linked] = await get_sequelize().query<{ cliq_id: string }>(
            `SELECT cliq_id FROM cliq.gethugs_links WHERE kind = 'user' AND gethugs_id = :id LIMIT 1`,
            { replacements: { id: r.user_id }, type: QueryTypes.SELECT, transaction: t },
        );
        ref = linked?.cliq_id ?? null;
    }
    if (ref) {
        const [user] = await get_sequelize().query<{ username: string | null; display_name: string | null }>(
            'SELECT username, display_name FROM cliq.users WHERE id = :id', { replacements: { id: ref }, type: QueryTypes.SELECT, transaction: t },
        );
        if (user) return { user_id: ref, name: user.display_name?.trim() || user.username || ref };
    }
    // Someone getHugs knows and cliq doesn't (added in getHugs itself): named as getHugs names them.
    return { user_id: r.user_id, name: r.name?.trim() || r.user_id };
}

/**
 * Applies one getHugs event to Core's row of that Hug, if Core has one.
 *
 * @returns whether anything was applied (false: not a Hug of Core's, a seq already applied, or nothing to do)
 */
export async function gethugs_apply(event: GethugsEvent): Promise<boolean> {
    const known = await Hug.findOne({ where: { gethugs_id: event.hug.id }, attributes: ['id'], raw: true });
    if (!known) return false;

    if (event.type === 'hug.closed') {
        // The daemon's own close (Core relays it): the row, no event — as Core's own close.
        const [count] = await Hug.update(
            { status: 'closed', outcome: event.outcome ?? null, closed_at: new Date(), next_remind_at: null },
            { where: { id: known.id, status: 'open' } },
        );
        return count > 0;
    }
    if (!['hug.responded', 'hug.expired', 'hug.cancelled'].includes(event.type) || event.seq == null) return false;
    const seq = event.seq;

    return get_sequelize().transaction(async (t) => {
        const hug = await Hug.findByPk(known.id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!hug || seq <= hug.gethugs_seq) return false;
        await hug.update({ gethugs_seq: seq }, { transaction: t });

        if (event.type === 'hug.responded' && event.response) {
            if (hug.status !== 'open') return true;
            const r = event.response;
            const responder = await responder_of(r.responder, t);
            const responded_at = typeof r.responded_at === 'number' ? new Date(r.responded_at).toISOString() : r.responded_at;
            await HugsService.relay_event(hug, 'response', {
                response: {
                    response_id: r.response_id, responder, via: r.via ?? [], values: r.values,
                    ...(r.summary ? { summary: r.summary } : {}), responded_at,
                },
            }, t);
            log.info('gethugs_response_relayed', { hug_id: hug.id, gethugs_seq: seq });
            return true;
        }

        // Expired or cancelled: once — not again when Core already ended it (the run's end).
        const how = event.type === 'hug.expired' ? 'expired' : 'cancelled';
        if (hug.status !== 'open') return true;
        await hug.update({ status: how, closed_at: new Date(), next_remind_at: null }, { transaction: t });
        await HugsService.relay_event(hug, how, how === 'cancelled' && event.reason ? { reason: event.reason } : {}, t);
        log.info(`gethugs_hug_${how}`, { hug_id: hug.id, gethugs_seq: seq });
        return true;
    });
}
