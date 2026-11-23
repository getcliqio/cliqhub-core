/**
 * getHugs' events, applied to Core's Hugs (PLAN-gethugs-step4-answers.md): what happens to a switched org's Hug in
 * getHugs reaches the daemon that asked as Core's own events do — a `response`, `expired` or `cancelled` event with
 * Core's next `seq`, delivered through the command outbox.
 *
 * One rule makes every path safe: an event of getHugs' seq `s` is applied only when `s > hugs.gethugs_seq`, and
 * applying it sets `gethugs_seq` in the same transaction. The feed, the catch-up after create and the recovery can all
 * bring the same event; it is applied once.
 */

import { Readable } from 'node:stream';
import { Op, QueryTypes, type Transaction } from 'sequelize';

import { get_sequelize } from '../db/sequelize.js';
import { get_logger } from '../lib/log.js';
import { Hug } from '../models/index.js';
import { EXTERNAL_SOURCE } from './gethugs_reconcile.js';
import { HugsService } from './hugs.service.js';
import { ArtifactStorageService } from './artifact_storage.service.js';
import { gethugs_partner } from './gethugs.service.js';

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

type FileValue = { document_id: string; name?: string; size?: number; content_type?: string; sha256?: string };
const is_document = (v: unknown): v is FileValue => Boolean(v) && typeof v === 'object' && typeof (v as FileValue).document_id === 'string';

/**
 * A file someone sent in an answer, as a ready run artifact of the Hug's run (`source = 'hug'`, its slot), once per
 * document (`cliq.gethugs_documents`, `in`): the file value `{ artifact_id, document_id, name, size, content_type, sha256 }`
 * — getHugs' `document_id` kept beside the run artifact, so getHugs' definitions (built-ins and team hugs, built with
 * `@gethugs/template-kit`) accept the answer too (PLAN-gethugs-step8-cutover.md decision 4).
 */
async function artifact_for(hug: Hug, slot: string, file: FileValue, uploaded_by: string | null): Promise<Record<string, unknown>> {
    const [known] = await get_sequelize().query<{ artifact_id: string }>(
        `SELECT artifact_id FROM cliq.gethugs_documents WHERE document_id = :document_id AND direction = 'in'`,
        { replacements: { document_id: file.document_id }, type: QueryTypes.SELECT },
    );
    let artifact_id = known?.artifact_id;
    let stored: { size: number; content_type: string; sha256: string; name: string } | null = null;
    if (!artifact_id) {
        const partner = gethugs_partner();
        const [org] = await get_sequelize().query<{ gethugs_id: string }>(
            `SELECT gethugs_id FROM cliq.gethugs_links WHERE org_id = :org_id AND kind = 'org' LIMIT 1`,
            { replacements: { org_id: hug.org_id }, type: QueryTypes.SELECT },
        );
        if (!org) throw new Error(`getHugs is not set up for org ${hug.org_id}`);
        const res = await partner.in_workspace(org.gethugs_id, hug.gethugs_workspace_id).documents.download({ document_id: file.document_id });
        const bytes = Buffer.from(await res.arrayBuffer());
        const out = await new ArtifactStorageService().upload({
            stream: Readable.from([bytes]), content_length: bytes.length,
            content_type: file.content_type || res.headers.get('content-type') || 'application/octet-stream',
            name: file.name || 'file', uploaded_by,
            target: { kind: 'hug_answer', run_id: hug.run_id, phase: hug.phase, hug_id: hug.id, requested_input: slot },
        });
        artifact_id = out.artifact_id;
        stored = out;
        await get_sequelize().query(
            `INSERT INTO cliq.gethugs_documents (workspace_id, document_id, artifact_id, direction) VALUES (:workspace_id, :document_id, :artifact_id, 'in')
             ON CONFLICT DO NOTHING`,
            { replacements: { workspace_id: hug.gethugs_workspace_id, document_id: file.document_id, artifact_id } },
        );
        log.info('gethugs_answer_file_stored', { hug_id: hug.id, slot, artifact_id });
    }
    return {
        artifact_id,
        document_id: file.document_id,
        name: stored?.name ?? file.name ?? 'file',
        size: stored?.size ?? file.size ?? 0,
        content_type: stored?.content_type ?? file.content_type ?? 'application/octet-stream',
        sha256: stored?.sha256 ?? file.sha256 ?? '',
    };
}

/** An answer's values with each file under one of the Hug's upload slots as a run artifact (one value or a list). */
async function with_run_files(hug: Hug, values: Record<string, unknown>, uploaded_by: string | null): Promise<Record<string, unknown>> {
    const out = { ...values };
    for (const slot of hug.files ?? []) {
        const v = out[slot.name];
        if (Array.isArray(v)) out[slot.name] = await Promise.all(v.map((f) => (is_document(f) ? artifact_for(hug, slot.name, f, uploaded_by) : f)));
        else if (is_document(v)) out[slot.name] = await artifact_for(hug, slot.name, v, uploaded_by);
    }
    return out;
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
            { status: 'closed', outcome: event.outcome ?? null, closed_at: new Date() },
            { where: { id: known.id, status: 'open' } },
        );
        return count > 0;
    }
    if (!['hug.responded', 'hug.expired', 'hug.cancelled'].includes(event.type) || event.seq == null) return false;
    const seq = event.seq;

    // An answer's files become run artifacts first — outside the transaction (they are downloads), and only for an
    // event not yet applied. A failed download throws: the event stays unapplied and is read again.
    let values: Record<string, unknown> | null = null;
    let responder_id: string | null = null;
    if (event.type === 'hug.responded' && event.response) {
        const hug = await Hug.findByPk(known.id);
        if (!hug || seq <= hug.gethugs_seq || hug.status !== 'open') {
            if (hug && seq > hug.gethugs_seq) await Hug.update({ gethugs_seq: seq }, { where: { id: hug.id, gethugs_seq: { [Op.lt]: seq } } });
            return false;
        }
        responder_id = await get_sequelize().transaction((t) => responder_of(event.response!.responder, t)).then((r) => r.user_id);
        // `uploaded_by` is a cliq user: someone getHugs knows and cliq doesn't is left out.
        const cliq_user = responder_id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(responder_id) ? responder_id : null;
        values = await with_run_files(hug, event.response.values, cliq_user);
    }

    return get_sequelize().transaction(async (t) => {
        const hug = await Hug.findByPk(known.id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!hug || seq <= hug.gethugs_seq) return false;
        await hug.update({ gethugs_seq: seq }, { transaction: t });

        if (event.type === 'hug.responded' && event.response) {
            if (hug.status !== 'open') return true;
            const r = event.response;
            const responder = await responder_of(r.responder, t);
            const answer = values ?? r.values;
            const responded_at = typeof r.responded_at === 'number' ? new Date(r.responded_at).toISOString() : r.responded_at;
            await HugsService.relay_event(hug, 'response', {
                response: {
                    response_id: r.response_id, responder, via: r.via ?? [], values: answer,
                    ...(r.summary ? { summary: r.summary } : {}), responded_at,
                },
            }, t);
            log.info('gethugs_response_relayed', { hug_id: hug.id, gethugs_seq: seq });
            return true;
        }

        // Expired or cancelled: once — not again when Core already ended it (the run's end).
        const how = event.type === 'hug.expired' ? 'expired' : 'cancelled';
        if (hug.status !== 'open') return true;
        await hug.update({ status: how, closed_at: new Date() }, { transaction: t });
        await HugsService.relay_event(hug, how, how === 'cancelled' && event.reason ? { reason: event.reason } : {}, t);
        log.info(`gethugs_hug_${how}`, { hug_id: hug.id, gethugs_seq: seq });
        return true;
    });
}
