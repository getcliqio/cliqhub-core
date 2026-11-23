/**
 * Hugs — Core's side of asking people (PLAN-hug-requests §6), through getHugs (PLAN-gethugs-integration.md; step 8:
 * every Hug is a getHugs one).
 *
 * Core opens a Hug in getHugs for a run's phase and keeps a row for it under the id its daemon minted; getHugs asks the
 * people, takes their answers and ends it. Core keeps the requester's event stream (numbered per Hug, from getHugs'
 * events) and delivers each event to the daemon that opened it; it relays the daemon's close and status line and a
 * run's end. It never interprets `params` or a response's `values`.
 */

import { Op, type Transaction } from 'sequelize';

import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';
import { Hug, HugEventRow, Realm } from '../models/index.js';
import type { HugAttachmentRow, HugFileSlotRow } from '../models/hug.model.js';
import { HugEnvelopeSchema, type HugEnvelope } from '../schemas/hug_types.js';
import type { HugEventType } from '../models/hug.model.js';
import { load_realm_info_map, load_run_info_map, resolve_team } from './hug_enrichment.js';
import { gethugs_cancel_run, gethugs_close, gethugs_create, gethugs_hug_url, gethugs_progress } from './gethugs_hugs.js';

const log = get_logger('svc.hugs');

/** How long past expiry Core keeps retrying delivery of a Hug's last events (§9). */
const DELIVERY_GRACE_MS = 60 * 60 * 1000;

/** How long a Hug's events are kept after it ends (§9.3); the command outbox keeps deliveries as long. */
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Input to {@link HugsService.create} (the route checked the run, realm and daemon). */
export interface CreateHugInput {
    /** Daemon-minted id (§9): a retried create adopts it instead of opening a second Hug. */
    hug_id?: string;
    run_id: string;
    daemon_id: string;
    realm_id: string;
    phase: string;
    iteration: number;
    /** The Hug's envelope, validated here (it comes from the daemon unchanged). */
    spec: unknown;
    /** A team hug's bundle (path → text), sent on the retry after `BUNDLE_MISSING`. */
    bundle?: Record<string, string>;
    /** Whether the caller may upload a bundle (a daemon of the Hug's realm). */
    may_upload_bundle?: boolean;
    actor_id: string | null;
}

/** One response as Core returns it. */
export interface HugResponseData {
    response_id: string;
    responder: { user_id: string; name: string };
    via: string[];
    /** The answer, as the hug's keys. */
    values: Record<string, unknown>;
    /** The answer in one line (absent when it has none). */
    summary?: string;
    responded_at: string;
}

/** A Hug as Core returns it (detail). */
export interface HugData {
    id: string;
    hug_url: string;
    run_id: string;
    run_name: string | null;
    team: string | null;
    phase: string;
    iteration: number;
    realm_id: string;
    realm_name: string | null;
    realm_slug: string | null;
    org_slug: string | null;
    daemon_id: string;
    title: string;
    /** The hug it was opened with: a getHugs built-in by name (no bundle), or a team hug and its bundle's hash. */
    hug: { name: string; sha256: string | null } | null;
    summary: string | null;
    /** The requester's latest status line while the Hug is open ("1 answer couldn't be used; …"); null otherwise. */
    progress: string | null;
    /** The hug's params (never read by Core). */
    params: Record<string, unknown>;
    /** Upload slots: the top-level answer keys that may carry uploads. */
    files: HugFileSlotRow[];
    /** Run files the frontend may read. */
    attachments: HugAttachmentRow[];
    channels: string[];
    status: string;
    outcome: string | null;
    expires_at: string;
    created_at: string;
    closed_at: string | null;
    /** The answers, each person's latest, oldest first (answered in getHugs). */
    responses: HugResponseData[];
}

/** One row of a run's Hug list. */
export interface HugListItem {
    hug_id: string;
    hug_url: string;
    title: string;
    summary: string | null;
    realm_id: string;
    realm_name: string | null;
    realm_slug: string | null;
    org_slug: string | null;
    run_id: string;
    run_name: string | null;
    team: string | null;
    phase: string;
    /** Which round of its phase this Hug is (0 for the first): a gate sent back asks again as the next one. */
    iteration: number;
    status: string;
    /** How it ended, in the requester's words ("Rejected by Ann"), or null while open. */
    outcome: string | null;
    /** Whether the caller has answered it. */
    responded: boolean;
    /** Epoch ms. */
    created_at: number;
    expires_at: number;
    closed_at: number | null;
}

/** One event of a Hug's requester stream. */
export interface HugEventData {
    hug_id: string;
    seq: number;
    type: HugEventType;
    payload: Record<string, unknown>;
}

/** A Hug's page in getHugs (PLAN-gethugs-step6-ui-link.md). */
export function hug_url_of(hug: Pick<Hug, 'gethugs_id'>): string {
    return gethugs_hug_url(hug.gethugs_id);
}

/** The answers of Hugs, from their `response` events (PLAN-gethugs-step4-answers.md): each person's latest, oldest first. */
export async function gethugs_responses(hug_ids: readonly string[]): Promise<Map<string, HugResponseData[]>> {
    const out = new Map<string, HugResponseData[]>();
    if (hug_ids.length === 0) return out;
    const rows = await HugEventRow.findAll({ where: { hug_id: { [Op.in]: [...hug_ids] }, type: 'response' }, order: [['hug_id', 'ASC'], ['seq', 'ASC']], raw: true });
    const latest = new Map<string, Map<string, HugResponseData>>();
    for (const row of rows) {
        const r = (row.payload as { response?: HugResponseData }).response;
        if (!r?.responder?.user_id) continue;
        const per = latest.get(row.hug_id) ?? new Map<string, HugResponseData>();
        per.delete(r.responder.user_id);
        per.set(r.responder.user_id, r);
        latest.set(row.hug_id, per);
    }
    for (const [hug_id, per] of latest) out.set(hug_id, [...per.values()]);
    return out;
}

/** Core's side of the Hug protocol. */
export class HugsService {
    /** Open a Hug: validate it and ask through getHugs ({@link gethugs_create}). */
    static async create(input: CreateHugInput): Promise<{ hug_id: string; hug_url: string }> {
        const spec = parse_envelope(input.spec);
        if (spec.expires_in_min === undefined) throw ApiError.unprocessable('expires_in_min is required — every Hug expires', 'invalid_hug');

        if (input.hug_id) {
            const existing = await Hug.findByPk(input.hug_id, { attributes: ['id', 'run_id', 'gethugs_id'], raw: true });
            if (existing) {
                if (existing.run_id !== input.run_id) throw ApiError.conflict('Hug id is already used by another run');
                return { hug_id: existing.id, hug_url: hug_url_of(existing) };
            }
        }

        const realm = await Realm.findByPk(input.realm_id, { attributes: ['org_id'], raw: true });
        if (!realm?.org_id) throw ApiError.not_found('Realm not found');
        const org_id = String(realm.org_id);

        // getHugs asks (PLAN-gethugs-step3-asking.md); Core keeps a row for the daemon.
        return gethugs_create({
            hug_id: input.hug_id, run_id: input.run_id, daemon_id: input.daemon_id, realm_id: input.realm_id, org_id,
            phase: input.phase, iteration: input.iteration, spec, bundle: input.bundle, may_upload_bundle: input.may_upload_bundle,
        });
    }

    /** One Hug with its responses. */
    static async get(hug_id: string): Promise<HugData> {
        const hug = await Hug.findByPk(hug_id);
        if (!hug) throw ApiError.not_found('Hug not found');
        const [runs, realms, responses] = await Promise.all([
            load_run_info_map([hug.run_id]),
            load_realm_info_map([hug.realm_id]),
            gethugs_responses([hug.id]).then((m) => m.get(hug.id) ?? []),
        ]);
        const run = runs.get(hug.run_id);
        const realm = realms.get(hug.realm_id);
        return {
            id: hug.id,
            hug_url: hug_url_of(hug),
            run_id: hug.run_id,
            run_name: run?.run_name ?? null,
            team: resolve_team(run),
            phase: hug.phase,
            iteration: hug.iteration,
            realm_id: hug.realm_id,
            realm_name: realm?.realm_name ?? null,
            realm_slug: realm?.realm_slug ?? null,
            org_slug: realm?.org_slug ?? null,
            daemon_id: hug.daemon_id,
            title: hug.title,
            hug: hug.hug_name ? { name: hug.hug_name, sha256: hug.hug_sha256 } : null,
            summary: hug.summary,
            progress: hug.status === 'open' ? hug.progress ?? null : null,
            params: hug.params,
            files: hug.files ?? [],
            attachments: hug.attachments ?? [],
            channels: hug.channels,
            status: hug.status,
            outcome: hug.outcome,
            expires_at: hug.expires_at.toISOString(),
            created_at: hug.created_at.toISOString(),
            closed_at: hug.closed_at ? hug.closed_at.toISOString() : null,
            responses,
        };
    }

    /**
     * A run's Hugs, in the order they opened (`hugs/get { run_id }`): every round of every phase — seen like the run (the
     * route checks `runs.view` on it), as `hugs/get_by_id` does. Default: any status.
     */
    static async list_for_run(opts: {
        user_id: string;
        run_id: string;
        statuses?: string[];
        limit?: number;
        offset?: number;
    }): Promise<{ hugs: HugListItem[]; total: number }> {
        const limit = Math.min(Math.max(1, opts.limit ?? 50), 100);
        const offset = Math.max(0, opts.offset ?? 0);
        const where = {
            run_id: opts.run_id,
            ...(opts.statuses?.length ? { status: { [Op.in]: opts.statuses } } : {}),
        };
        const [total, rows] = await Promise.all([
            Hug.count({ where }),
            Hug.findAll({ where, order: [['created_at', 'ASC'], ['id', 'ASC']], limit, offset }),
        ]);
        const [runs, realms, answers] = await Promise.all([
            load_run_info_map(rows.map((r) => r.run_id)),
            load_realm_info_map(rows.map((r) => r.realm_id)),
            gethugs_responses(rows.map((r) => r.id)),
        ]);
        return {
            total,
            hugs: rows.map((row) => {
                const run = runs.get(row.run_id);
                const realm = realms.get(row.realm_id);
                return {
                    hug_id: row.id,
                    hug_url: hug_url_of(row),
                    title: row.title,
                    summary: row.summary ?? null,
                    realm_id: row.realm_id,
                    realm_name: realm?.realm_name ?? null,
                    realm_slug: realm?.realm_slug ?? null,
                    org_slug: realm?.org_slug ?? null,
                    run_id: row.run_id,
                    run_name: run?.run_name ?? null,
                    team: resolve_team(run),
                    phase: row.phase,
                    iteration: row.iteration ?? 0,
                    status: row.status,
                    outcome: row.outcome ?? null,
                    responded: (answers.get(row.id) ?? []).some((a) => a.responder.user_id === opts.user_id),
                    created_at: row.created_at.getTime(),
                    expires_at: row.expires_at.getTime(),
                    closed_at: row.closed_at ? row.closed_at.getTime() : null,
                };
            }),
        };
    }

    /**
     * The requester closes the Hug with its outcome, in getHugs ({@link gethugs_close}); later answers are refused there.
     * Idempotent. Only the daemon that opened it may close it (403 otherwise).
     */
    static async close(input: { hug_id: string; outcome: string; daemon_id: string }): Promise<{ status: string }> {
        const hug = await Hug.findByPk(input.hug_id);
        if (!hug) throw ApiError.not_found('Hug not found');
        if (hug.daemon_id !== input.daemon_id) throw ApiError.forbidden('Only the daemon that opened this Hug may close it');
        return { status: await gethugs_close(hug, input.outcome) };
    }

    /**
     * Catch-up for a daemon (§9.4): its Hugs' events after each cursor (up to 500 per call), and
     * each Hug's status — read from the Hug itself, so an ended Hug whose events were cleaned up
     * still reports how it ended.
     */
    static async get_events(input: {
        daemon_id: string;
        cursors: Array<{ hug_id: string; after_seq: number }>;
    }): Promise<{ events: HugEventData[]; hugs: Array<{ hug_id: string; status: string; last_seq: number }>; has_more: boolean }> {
        const ids = [...new Set(input.cursors.map((c) => c.hug_id))];
        if (ids.length === 0) return { events: [], hugs: [], has_more: false };
        const hugs = await Hug.findAll({ where: { id: { [Op.in]: ids }, daemon_id: input.daemon_id }, attributes: ['id', 'status', 'last_seq'], raw: true });
        const own = new Set(hugs.map((h) => h.id));
        const after = new Map(input.cursors.map((c) => [c.hug_id, c.after_seq]));
        const LIMIT = 500;
        const rows = own.size === 0 ? [] : await HugEventRow.findAll({
            where: { [Op.or]: [...own].map((id) => ({ hug_id: id, seq: { [Op.gt]: after.get(id) ?? 0 } })) },
            order: [['hug_id', 'ASC'], ['seq', 'ASC']],
            limit: LIMIT + 1,
            raw: true,
        });
        return {
            events: rows.slice(0, LIMIT).map((r) => ({ hug_id: r.hug_id, seq: r.seq, type: r.type, payload: r.payload })),
            hugs: hugs.map((h) => ({ hug_id: h.id, status: h.status, last_seq: h.last_seq })),
            has_more: rows.length > LIMIT,
        };
    }

    /** A run ended (any reason): its open Hugs are cancelled in getHugs and the requester is told (§6.2). */
    static async cancel_for_run(run_id: string): Promise<number> {
        const open = await Hug.findAll({ where: { run_id, status: 'open' } });
        return open.length ? gethugs_cancel_run(run_id, open) : 0;
    }

    /**
     * Delete the events of Hugs that ended more than 7 days ago (§9.3). The Hug row stays, so a
     * daemon catching up later still learns how it ended (§9.4).
     *
     * @returns how many events were deleted
     */
    static async delete_old_events(now = new Date()): Promise<number> {
        const before = new Date(now.getTime() - EVENT_RETENTION_MS);
        const ended = await Hug.findAll({
            where: { status: { [Op.ne]: 'open' }, closed_at: { [Op.lt]: before } },
            attributes: ['id'],
            raw: true,
        });
        if (ended.length === 0) return 0;
        const deleted = await HugEventRow.destroy({ where: { hug_id: { [Op.in]: ended.map((h) => h.id) } } });
        if (deleted > 0) log.info('hug_events_deleted', { hugs: ended.length, events: deleted });
        return deleted;
    }

    // ── internals ───────────────────────────────────────────────────

    /**
     * Records one event of a Hug relayed from getHugs (PLAN-gethugs-step4-answers.md) with Core's next `seq`, and queues
     * it for the daemon — in `transaction`, as Core's own events are.
     *
     * @returns the event's `seq`
     */
    static async relay_event(hug: Hug, type: HugEventType, payload: Record<string, unknown>, transaction: Transaction): Promise<number> {
        const seq = await append_seq(hug.id, transaction);
        await HugEventRow.create({ hug_id: hug.id, seq, type, payload, created_at: new Date() }, { transaction });
        await HugsService._deliver(hug, { hug_id: hug.id, seq, type, payload }, transaction);
        return seq;
    }

    /**
     * Queue one event for the daemon that opened the Hug, in the transaction that wrote it (§9), and
     * retry it until shortly after the Hug expires.
     */
    private static async _deliver(hug: Hug, event: HugEventData, transaction: Transaction): Promise<void> {
        const { command_outbox_enqueue } = await import('./command_outbox.service.js');
        await command_outbox_enqueue(hug.daemon_id, '/v1/hugs/deliver', { ...event, run_id: hug.run_id }, {
            deliver_until: Math.max(hug.expires_at.getTime(), Date.now()) + DELIVERY_GRACE_MS,
            transaction,
        });
    }

    /**
     * The requester's status line for an open Hug (PLAN-hug-widgets §6.1 `progress`), from a `hug.progress` run activity
     * event. Informational: written only for a Hug of `run_id` that `daemon_id` opened and that is still open; anything
     * else is ignored.
     */
    static async set_progress(run_id: string, daemon_id: string | null, hug_id: string, progress: string | null): Promise<void> {
        if (!daemon_id) return;
        const line = progress?.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
        const [count] = await Hug.update({ progress: line }, { where: { id: hug_id, run_id, daemon_id, status: 'open' } });
        if (count === 0) return;
        const hug = await Hug.findByPk(hug_id);
        if (hug) await gethugs_progress(hug, line);
    }
}

/**
 * A Hug's envelope, checked.
 *
 * @throws ApiError 422 `invalid_hug` — a pre-hug (`template`) spec from an older cliq, or an invalid envelope
 */
function parse_envelope(raw: unknown): HugEnvelope {
    if (raw && typeof raw === 'object' && 'template' in raw) {
        throw ApiError.unprocessable('This Hug uses templates, which this CliqHub no longer takes — update cliq', 'invalid_hug');
    }
    const parsed = HugEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
        throw ApiError.unprocessable(`Invalid Hug: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`).join('; ')}`, 'invalid_hug');
    }
    return parsed.data;
}

/** Allocate the Hug's next event number (in the caller's transaction). */
async function append_seq(hug_id: string, t: Transaction): Promise<number> {
    await Hug.increment('last_seq', { by: 1, where: { id: hug_id }, transaction: t });
    const row = await Hug.findByPk(hug_id, { attributes: ['last_seq'], transaction: t, raw: true });
    return Number(row!.last_seq);
}
