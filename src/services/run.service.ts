import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';
import yaml from 'js-yaml';

import {
    Run, RunEvent, RunLog, RunLogLine,
    RunPhase, RunArtifact, Team, Scope, Workspace, RealmMember,
    Daemon, Realm,
} from '../models/index.js';

import { get_sequelize } from '../lib/sequelize.js';
import { RealmService } from './realm.service.js';
import { parse_log_level, split_log_chunk } from '../lib/log_line_parse.js';
import { generate_slug } from '../lib/slug.js';
import { QueryTypes } from 'sequelize';
import { EventSubmitService } from '../events/submit.service.js';
import type { EventType } from '../events/types.js';

/**
 * Control commands that target a single run (cancel, supply inputs).
 * The dashboard uses this list to detect whether any of them are
 * still in flight so it can render a "cancel queued — waiting on
 * daemon" banner instead of the previous silent-toast+dead-button UX.
 * Ordered by rough severity so a cancel wins if two rows exist.
 */
/** Strictly increasing epoch-ms for append-only run leaf cursors (matches cliq-store). */
let _monotonic_event_ms = 0;
function next_event_created_at_ms(): number {
    const t = Date.now();
    _monotonic_event_ms = t <= _monotonic_event_ms ? _monotonic_event_ms + 1 : t;
    return _monotonic_event_ms;
}

const RUN_CONTROL_ENDPOINTS = [
    '/v1/cancel',
    '/v1/runs/supply_inputs',
    // Resume is a control command like cancel — the user needs to know
    // when it's been picked up by the daemon, otherwise clicking Resume
    // and watching an unchanged run for two minutes feels like a bug.
    '/v1/resume',
    // Execute is the *initial* dispatch. Also worth surfacing while it's
    // in-flight — dispatched runs sometimes take 20+ seconds to appear
    // as `running` when the daemon is busy or the workspace is cold.
    '/v1/execute',
] as const;

/**
 * Shape returned by `_load_pending_control`. Encodes everything the
 * UI needs to decide whether to disable the Cancel button, what to
 * show in the banner, and whether to nag the operator about a stuck
 * queue ("2 attempts, last error: connection timeout").
 */
export interface PendingControl {
    tx_id: string;
    endpoint: string;
    enqueued_at: number;
    attempts: number;
    max_attempts: number;
    delivered_at: number | null;
    last_error: string | null;
    ack_status: string | null;
}

/**
 * Return the newest in-flight control command for this run, or null.
 * "In flight" = not fully acked AND not permanently failed (i.e.
 * `attempts < max_attempts`). We look up by `payload->>'run_id'` so
 * we don't need a schema change; the JSONB index isn't needed at
 * expected volumes (each run has at most 1–2 pending controls).
 */
async function _load_pending_control(
    daemon_id: string | null,
    run_id: string,
): Promise<PendingControl | null> {
    if (!daemon_id) return null;
    const sq = get_sequelize();
    const rows = await sq.query<{
        tx_id: string; endpoint: string; created_at: string;
        attempts: number; max_attempts: number;
        delivered_at: string | null; error: string | null;
        ack_status: string | null;
    }>(
        `
        SELECT "tx_id", "endpoint", "created_at",
               "attempts", "max_attempts",
               "delivered_at", "error", "ack_status"
          FROM cliq."command_outbox"
         WHERE "daemon_id" = :daemon_id
           AND "endpoint"  IN (:endpoints)
           AND "payload"->>'run_id' = :run_id
           AND "acked_at"  IS NULL
           AND "attempts"  < "max_attempts"
        ORDER BY "created_at" DESC
         LIMIT 1
        `,
        {
            replacements: {
                daemon_id,
                endpoints: [...RUN_CONTROL_ENDPOINTS],
                run_id,
            },
            type: QueryTypes.SELECT,
        },
    );
    const row = rows[0];
    if (!row) return null;
    return {
        tx_id: row.tx_id,
        endpoint: row.endpoint,
        enqueued_at: Number(row.created_at),
        attempts: Number(row.attempts),
        max_attempts: Number(row.max_attempts),
        delivered_at: row.delivered_at !== null ? Number(row.delivered_at) : null,
        last_error: row.error,
        ack_status: row.ack_status,
    };
}

/**
 * Shape consumed by the run detail page's `Pending_control_banner`
 * / `Force_terminate_banner`. Kept flat and JSON-safe.
 *
 * Eligibility triggers are strings (not booleans) because the UI
 * copy differs per trigger — "daemon offline for 4m" reads very
 * differently from "cancel queued 12m ago, no ack".
 */
export interface ForceTerminateStatus {
    /** True iff run.force_terminated_at is set. */
    already_terminated: boolean;
    terminated_at: number | null;
    terminated_by_user_id: string | null;
    terminated_reason: string | null;

    /** True iff Hub would accept a POST /v1/runs/force_terminate now. */
    eligible: boolean;
    /** Which condition tripped eligibility (null when !eligible). */
    trigger: 'stale_cancel' | 'daemon_offline' | 'lease_expired' | null;
    /** Human message when !eligible (used in the tooltip). */
    blocker: string | null;
}

/**
 * Read force-terminate context directly from Postgres via raw SQL —
 * the shared `Run` model (from `@getcliqio/cliq-store`) doesn't yet
 * declare `force_terminated_at`, so we can't get the value via the
 * ORM without a package bump. Nullable columns; a raw select is
 * fine and matches how the reaper reads similar signals.
 */
const FORCE_TERM_STALE_CANCEL_MS = 5 * 60 * 1000;
const FORCE_TERM_DAEMON_STALE_MS = 90 * 1000;

async function _load_force_terminate_status(
    run_id: string,
    daemon_id: string | null,
): Promise<ForceTerminateStatus> {
    const sq = get_sequelize();
    const now = Date.now();

    // 1. Direct state read for the "already terminated" case + the
    //    run's lease + current state (need to know whether to bother
    //    computing eligibility at all).
    const run_rows = await sq.query<{
        state: string;
        lease_expires_at: string | null;
        force_terminated_at: string | null;
        force_terminated_by_user_id: string | null;
        force_terminated_reason: string | null;
    }>(
        `SELECT "state", "lease_expires_at", "force_terminated_at",
                "force_terminated_by_user_id", "force_terminated_reason"
           FROM cliq."team_runs"
          WHERE "run_id" = :run_id
          LIMIT 1`,
        { replacements: { run_id }, type: QueryTypes.SELECT },
    );
    const row = run_rows[0];
    if (!row) {
        // Shouldn't happen — caller has already loaded the run — but
        // return a safe default rather than throwing.
        return _force_status_empty();
    }

    if (row.force_terminated_at !== null && row.force_terminated_at !== undefined) {
        return {
            already_terminated: true,
            terminated_at: Number(row.force_terminated_at),
            terminated_by_user_id: row.force_terminated_by_user_id,
            terminated_reason: row.force_terminated_reason,
            eligible: false,
            trigger: null,
            blocker: null,
        };
    }

    // Only live runs are eligible — a completed/failed/cancelled run
    // is already terminal, no point offering force-terminate.
    if (!['running', 'awaiting_input'].includes(row.state)) {
        return _force_status_empty();
    }

    // Trigger 1: stale cancel in the outbox.
    if (daemon_id) {
        const stale_cancel_rows = await sq.query<{ oldest: string | null }>(
            `SELECT MIN("created_at")::TEXT AS "oldest"
               FROM cliq."command_outbox"
              WHERE "endpoint" = '/v1/cancel'
                AND "acked_at" IS NULL
                AND "attempts" < "max_attempts"
                AND "payload"->>'run_id' = :run_id`,
            { replacements: { run_id }, type: QueryTypes.SELECT },
        );
        const oldest = stale_cancel_rows[0]?.oldest;
        if (oldest !== null && oldest !== undefined
            && (now - Number(oldest)) >= FORCE_TERM_STALE_CANCEL_MS) {
            return _force_status_eligible('stale_cancel');
        }
    }

    // Trigger 2: daemon hasn't heartbeated recently.
    if (daemon_id) {
        const dmn_rows = await sq.query<{ last_heartbeat: string | null }>(
            `SELECT "last_heartbeat"::TEXT AS "last_heartbeat"
               FROM cliq."daemons"
              WHERE "id" = :daemon_id
              LIMIT 1`,
            { replacements: { daemon_id }, type: QueryTypes.SELECT },
        );
        const dmn = dmn_rows[0];
        const last_hb = dmn?.last_heartbeat ? Number(dmn.last_heartbeat) : 0;
        if (!dmn || last_hb === 0 || (now - last_hb) >= FORCE_TERM_DAEMON_STALE_MS) {
            return _force_status_eligible('daemon_offline');
        }
    }

    // Trigger 3: action lease already expired.
    const lease = row.lease_expires_at ? Number(row.lease_expires_at) : 0;
    if (lease > 0 && lease < now) {
        return _force_status_eligible('lease_expired');
    }

    return {
        already_terminated: false,
        terminated_at: null,
        terminated_by_user_id: null,
        terminated_reason: null,
        eligible: false,
        trigger: null,
        blocker: 'daemon is heartbeating and no cancel has been queued long enough — try normal Cancel first',
    };
}

function _force_status_empty(): ForceTerminateStatus {
    return {
        already_terminated: false,
        terminated_at: null,
        terminated_by_user_id: null,
        terminated_reason: null,
        eligible: false,
        trigger: null,
        blocker: null,
    };
}

function _force_status_eligible(
    trigger: 'stale_cancel' | 'daemon_offline' | 'lease_expired',
): ForceTerminateStatus {
    return {
        already_terminated: false,
        terminated_at: null,
        terminated_by_user_id: null,
        terminated_reason: null,
        eligible: true,
        trigger,
        blocker: null,
    };
}


const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Default action lease for running runs (60 min). Env: RUN_LEASE_TTL_MS
 *
 * Bumped from 30 → 60 min after w2-parser (and similar long-phase teams)
 * were being force-crashed at the 30-min mark. The lease is now also
 * refreshed on every event batch (see ingest_events → touch_lease), so
 * any phase that emits events (LLM output, tool calls, thinking) is
 * kept alive indefinitely. The 60-min TTL is only the fallback window
 * for silent phases (pure CPU/IO loops that stream nothing).
 */
const RUN_LEASE_TTL_MS = parseInt(process.env.RUN_LEASE_TTL_MS ?? String(60 * 60 * 1000), 10);
/** Longer lease while awaiting human/agent input (24h). Env: RUN_LEASE_AWAITING_TTL_MS */
const RUN_LEASE_AWAITING_TTL_MS = parseInt(
    process.env.RUN_LEASE_AWAITING_TTL_MS ?? String(24 * 60 * 60 * 1000),
    10,
);

function lease_deadline(kind: 'running' | 'awaiting_input' = 'running'): number {
    const ttl = kind === 'awaiting_input' ? RUN_LEASE_AWAITING_TTL_MS : RUN_LEASE_TTL_MS;
    return Date.now() + ttl;
}

type RunInputs = Readonly<Record<string, unknown>>;

function hydrate_inputs(raw: string | null): RunInputs {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as RunInputs;
    } catch { /* corrupt JSON */ }
    return {};
}

/**
 * Parse a JSON string into an array of unknown, or `[]` on any failure
 * (null, invalid JSON, non-array). Used to hydrate JSONB columns that
 * some drivers return as text instead of already-parsed values.
 */
function _safe_parse_array(raw: string): unknown[] {
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

/** Ordered phase names from a team YAML manifest (`phases:` list). */
function phase_names_from_manifest(manifest: string | null | undefined): string[] {
    return phase_specs_from_manifest(manifest).map((p) => p.name);
}

/** Structured phase spec extracted from a team manifest. */
interface PhaseManifestSpec {
    name: string;
    phase_type: string;
    depends_on: string[];
    max_iterations?: number;
}

/** Normalize a phases array (workflow_json or team.yml) into ordered specs. */
function phase_specs_from_phases_array(phases: unknown): PhaseManifestSpec[] {
    if (!Array.isArray(phases)) return [];
    const specs: PhaseManifestSpec[] = [];
    for (const p of phases) {
        if (!p || typeof p !== 'object') continue;
        const raw = p as {
            name?: unknown;
            type?: unknown;
            phase_type?: unknown;
            depends_on?: unknown;
            max_iterations?: unknown;
        };
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        if (!name) continue;
        const type_raw = typeof raw.type === 'string' && raw.type.trim()
            ? raw.type.trim()
            : (typeof raw.phase_type === 'string' && raw.phase_type.trim()
                ? raw.phase_type.trim()
                : 'standard');
        const depends_on: string[] = Array.isArray(raw.depends_on)
            ? raw.depends_on
                .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
                .map((d) => d.trim())
            : [];
        const max_iterations = typeof raw.max_iterations === 'number'
            && Number.isFinite(raw.max_iterations)
                ? raw.max_iterations
                : undefined;
        const spec: PhaseManifestSpec = { name, phase_type: type_raw, depends_on };
        if (max_iterations !== undefined) spec.max_iterations = max_iterations;
        specs.push(spec);
    }
    return specs;
}

/**
 * Parse team_versions.workflow_json (`{ phases, support? }`) into ordered
 * phase specs. Falls back to empty when JSON is corrupt or has no phases.
 */
function phase_specs_from_workflow_json(
    workflow_json: string | null | undefined,
): PhaseManifestSpec[] {
    if (!workflow_json) return [];
    try {
        const doc = JSON.parse(workflow_json) as { phases?: unknown } | null;
        return phase_specs_from_phases_array(doc?.phases);
    } catch {
        return [];
    }
}

/**
 * Parse the team manifest (YAML or JSON — `yaml.load` handles both) and
 * return the ordered phase specs. Missing `type` defaults to `standard`.
 * Missing `depends_on` is left empty — callers may synthesize linear
 * dependencies from array order if desired.
 */
function phase_specs_from_manifest(
    manifest: string | null | undefined,
): PhaseManifestSpec[] {
    if (!manifest) return [];
    try {
        const doc = yaml.load(manifest) as { phases?: unknown } | null;
        return phase_specs_from_phases_array(doc?.phases);
    } catch {
        return [];
    }
}

function sort_phases_by_workflow(
    rows: InstanceType<typeof RunPhase>[],
    order: string[],
): InstanceType<typeof RunPhase>[] {
    if (order.length === 0) return rows;
    const idx = new Map(order.map((n, i) => [n, i]));
    return [...rows].sort((a, b) => {
        const sa = Number(a.getDataValue('sequence') ?? 0);
        const sb = Number(b.getDataValue('sequence') ?? 0);
        const ia = idx.has(a.phase) ? idx.get(a.phase)! : 10_000 + sa;
        const ib = idx.has(b.phase) ? idx.get(b.phase)! : 10_000 + sb;
        if (ia !== ib) return ia - ib;
        return sa - sb;
    });
}


export class RunService {

    // ── Core run CRUD ──────────────────────────────────────────────

    private static readonly _run_includes = [
        {
            model: Team,
            as: 'team',
            attributes: ['id', 'slug', 'scope_id'],
            include: [{ model: Scope, as: 'scope', attributes: ['slug'] }],
        },
        {
            model: Workspace,
            as: 'workspace',
            attributes: ['id', 'path', 'name'],
        },
    ];

    private static _enrich_run(r: any) {
        const plain = r.toJSON();
        const team = plain.team;
        const ws = plain.workspace;
        // Derived: best-effort "last activity" without a dedicated column.
        // Fine as a coarse UX signal — replaced by a real updated_at column
        // if we ever need per-log/event freshness.
        // Postgres BIGINT returns as string, sqlite as number — normalise.
        const to_ms = (v: unknown): number | null => {
            if (v === null || v === undefined) return null;
            if (typeof v === 'number' && Number.isFinite(v)) return v;
            if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
            return null;
        };
        const last_updated_at = to_ms(plain.completed_at) ?? to_ms(plain.started_at);
        return {
            ...plain,
            team_label: team ? `@${team.scope?.slug ?? 'default'}/${team.slug}` : null,
            workspace_name: ws?.name ?? ws?.path?.split('/').pop() ?? null,
            workspace_dir: ws?.path ?? null,
            last_updated_at,
            team: undefined,
            workspace: undefined,
        };
    }

    /**
     * List runs the caller can read. Access is gated by realm membership:
     *   - `daemon_id`     → runs on that daemon (caller must already be
     *                       authorised to reach this code path).
     *   - `realm_id`      → runs on any daemon in that realm.
     *   - `user_id`       → runs on any daemon in any realm the user is a
     *                       member of (default UI path).
     *   - `site_admin`    → no realm gate (all runs).
     *
     * Legacy team-scope gating (`scope_ids`) was ANDed on top and hid runs
     * whose teams live outside the caller's owned scopes — e.g. published
     * or registry teams executed inside the caller's own realm. Realm
     * membership is the correct read gate; scope filtering is dropped.
     */
    static async list_recent(
        limit = 20,
        daemon_id?: string,
        filters?: {
            query?: string;
            /**
             * Single state string OR an array. Arrays let the dashboard's
             * "Failed" tile drill into `failed` and `crashed` together —
             * otherwise the count on the tile and the count in the
             * filtered list disagree.
             */
            state?: string | string[];
            realm_id?: string;
            offset?: number;
            since_ms?: number;
            until_ms?: number;
            site_admin?: boolean;
            user_id?: string;
            /**
             * Numeric org id (X-Org-Id header). When set together
             * with user_id, the realm gate is intersected with the
             * user's realms in this org — so the org switcher in the
             * UI acts as a first-class filter instead of a decorator.
             */
            org_id?: string;
            sort_by?: 'run_name' | 'state' | 'team' | 'started_at' | 'last_updated_at';
            sort_dir?: 'asc' | 'desc';
        },
    ): Promise<{ runs: ReturnType<typeof RunService._enrich_run>[]; total: number }> {
        const where: Record<string, unknown> = {};
        if (daemon_id) {
            where.daemon_id = daemon_id;
        }
        // Realm gate: strict `team_runs.realm_id` match. The realm is
        // snapshotted at run-create time (see RunService.create) so
        // membership churn on the daemon side can't leak runs across
        // realms. No daemon-hop fallback — that path is what caused
        // cross-user run leakage when a daemon ended up as a member of
        // multiple realms (see prod fossil 99a2f0f1).
        if (!daemon_id && filters?.realm_id) {
            where.realm_id = filters.realm_id;
        }
        if (!daemon_id && !filters?.realm_id && !filters?.site_admin && filters?.user_id) {
            // Intersect the user's realms with the active org (if the
            // request carries one). Without this the home dashboard
            // leaks runs from every org the user has touched — the
            // org switcher up top would be lying.
            const realm_ids = filters.org_id
                ? await RealmService.list_realm_ids_for_user_in_org(filters.user_id, filters.org_id)
                : await RealmService.list_realm_ids_for_user(filters.user_id);
            if (realm_ids.length === 0) return { runs: [], total: 0 };
            where.realm_id = { [Op.in]: realm_ids };
        }
        if (filters?.state) {
            where.state = Array.isArray(filters.state)
                ? { [Op.in]: filters.state }
                : filters.state;
        }
        if (filters?.since_ms != null || filters?.until_ms != null) {
            const started: Record<string | symbol, number> = {};
            if (filters.since_ms != null) started[Op.gte] = filters.since_ms;
            if (filters.until_ms != null) started[Op.lte] = filters.until_ms;
            where.started_at = started;
        }

        // Server-side text search: run_id / run_name (SQL ILIKE-like).
        const query = filters?.query?.trim();
        if (query) {
            const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
            const dialect = get_sequelize().getDialect();
            const like_op = dialect === 'postgres' ? Op.iLike : Op.like;
            where[Op.and as unknown as string] = [
                ...(Array.isArray(where[Op.and as unknown as string])
                    ? (where[Op.and as unknown as string] as unknown[])
                    : []),
                {
                    [Op.or]: [
                        { run_id: { [like_op]: like } },
                        { run_name: { [like_op]: like } },
                    ],
                },
            ];
        }

        const offset = Math.max(0, filters?.offset ?? 0);
        const page_limit = Math.min(Math.max(1, limit), 200);
        const sort_dir = (filters?.sort_dir ?? 'desc').toUpperCase() as 'ASC' | 'DESC';
        const sort_by = filters?.sort_by ?? 'last_updated_at';

        // Map logical sort key -> Sequelize order clause.
        // `last_updated_at` = COALESCE(completed_at, started_at) — no dedicated
        // column yet; expressed as literal so it sorts consistently across
        // Postgres/sqlite without new schema.
        const order: any[] = (() => {
            const seq = get_sequelize();
            if (sort_by === 'run_name') return [[seq.fn('LOWER', seq.col('Run.run_name')), sort_dir], ['started_at', 'DESC']];
            if (sort_by === 'state') return [['state', sort_dir], ['started_at', 'DESC']];
            if (sort_by === 'team') return [[{ model: Team, as: 'team' }, 'slug', sort_dir], ['started_at', 'DESC']];
            if (sort_by === 'started_at') return [['started_at', sort_dir]];
            return [
                [seq.fn('COALESCE', seq.col('Run.completed_at'), seq.col('Run.started_at')), sort_dir],
                ['started_at', 'DESC'],
            ];
        })();

        const total = await Run.count({ where });
        const rows = await Run.findAll({
            where,
            include: RunService._run_includes,
            order,
            limit: page_limit,
            offset,
            subQuery: false,
        });
        return { runs: rows.map(RunService._enrich_run), total };
    }

    static async list_by_workspace(workspace_id: string, limit = 50, offset = 0) {
        const where = { workspace_id };
        const page_limit = Math.min(Math.max(1, limit), 200);
        const page_offset = Math.max(0, offset);
        const total = await Run.count({ where });
        const rows = await Run.findAll({
            where,
            include: RunService._run_includes,
            order: [['started_at', 'DESC']],
            limit: page_limit,
            offset: page_offset,
        });
        return { runs: rows.map(RunService._enrich_run), total };
    }

    static async get(run_id: string) {
        return Run.findByPk(run_id) ?? null;
    }

    /**
     * Return the newest in-flight control command (cancel / supply
     * inputs) that targets this run, or null. Exposed as a service
     * method so the get_by_id controller can enrich its response
     * without changing the return shape of `RunService.get` — many
     * callers rely on getting the raw Sequelize instance back.
     *
     * See the run detail page's `Pending_control_banner` for the UX
     * this powers: previously the UI had no way to see the enqueued
     * command, so "clicked Cancel — nothing happened" was a
     * regularly reported bug.
     */
    static async load_pending_control(
        daemon_id: string | null,
        run_id: string,
    ): Promise<PendingControl | null> {
        return _load_pending_control(daemon_id, run_id);
    }

    /**
     * Force-terminate context for the run detail page banner. Two
     * cases the UI cares about:
     *   • Run has already been force-cancelled → banner reads
     *     "Force cancelled by @user at T (reason)".
     *   • Run is live but the daemon is unresponsive → banner
     *     grows a "Force terminate" button and shows why (trigger).
     * Eligibility is computed with the same rules as the service
     * gate itself (5min stale cancel / 90s no heartbeat / lease
     * expired) — kept in one place so UI-shown eligibility can
     * never drift from server-enforced eligibility.
     */
    static async load_force_terminate_status(
        run_id: string,
        daemon_id: string | null,
    ): Promise<ForceTerminateStatus> {
        return _load_force_terminate_status(run_id, daemon_id);
    }

    /**
     * Read `team_runs.state_lost_at` via raw SQL — the shared `Run`
     * model (from `@getcliqio/cliq-store`) doesn't declare this
     * column, so we can't get the value via the ORM without a
     * package bump (same rationale as `force_terminated_at` above).
     *
     * Returns the ms-epoch timestamp when the orphan-detector fired,
     * or null when the run is healthy. Consumed by the run detail
     * page to render the "state lost — Run again" affordance.
     */
    static async load_state_lost_at(run_id: string): Promise<number | null> {
        const sq = get_sequelize();
        const rows = await sq.query<{ state_lost_at: string | null }>(
            `SELECT "state_lost_at"
               FROM cliq."team_runs"
              WHERE "run_id" = :run_id
              LIMIT 1`,
            { replacements: { run_id }, type: QueryTypes.SELECT },
        );
        const raw = rows[0]?.state_lost_at;
        if (raw === null || raw === undefined) return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * Read `team_runs.team_version_id` via raw SQL — shared Run model
     * does not declare this Hub-only column.
     */
    static async load_team_version_id(run_id: string): Promise<string | null> {
        const sq = get_sequelize();
        try {
            const rows = await sq.query<{ team_version_id: string | null }>(
                `SELECT "team_version_id"
                   FROM cliq."team_runs"
                  WHERE "run_id" = :run_id
                  LIMIT 1`,
                { replacements: { run_id }, type: QueryTypes.SELECT },
            );
            const raw = rows[0]?.team_version_id;
            return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
        } catch {
            return null;
        }
    }

    /**
     * Resolve public.team_versions row for a team: explicit version_id
     * (must belong to team_id) or latest semver. Returns null when the
     * team has no published versions (local-only catalog).
     */
    private static async _resolve_team_version(
        team_id: string,
        version_id?: string | null,
    ): Promise<{
        id: string;
        version: string;
        workflow_json: string;
        manifest_yaml: string;
    } | null> {
        try {
            const { TeamVersionRepository } = await import(
                '../repositories/team_version_repository.js'
            );
            const repo = new TeamVersionRepository();
            if (version_id?.trim()) {
                const row = await repo.find_by_id(version_id.trim());
                if (!row || row.team_id !== team_id) return null;
                return {
                    id: row.id,
                    version: row.version,
                    workflow_json: row.workflow_json ?? '{}',
                    manifest_yaml: row.manifest_yaml ?? '',
                };
            }
            const latest = await repo.find_latest_detail(team_id);
            if (!latest) return null;
            return {
                id: latest.id,
                version: (latest as { version?: string }).version
                    ?? (await repo.find_latest_version(team_id))
                    ?? '0.0.0',
                workflow_json: latest.workflow_json ?? '{}',
                manifest_yaml: latest.manifest_yaml ?? '',
            };
        } catch {
            return null;
        }
    }

    /** Specs from a team_versions row — workflow_json first, then manifest_yaml. */
    private static _specs_from_version_row(row: {
        workflow_json?: string;
        manifest_yaml?: string;
    }): PhaseManifestSpec[] {
        const from_json = phase_specs_from_workflow_json(row.workflow_json);
        if (from_json.length > 0) return from_json;
        return phase_specs_from_manifest(row.manifest_yaml);
    }

    /**
     * On first create: stamp team_version_id (latest) and seed phase rows.
     * Replaces daemon `/v1/runs/phases/create_many`.
     */
    private static async _stamp_version_and_seed(
        run_id: string,
        team_id: string,
    ): Promise<void> {
        try {
            const version = await this._resolve_team_version(team_id);
            if (version) {
                await get_sequelize().query(
                    `UPDATE cliq."team_runs" SET "team_version_id" = $1 WHERE "run_id" = $2`,
                    { bind: [version.id, run_id] },
                );
                const specs = this._specs_from_version_row(version);
                if (specs.length > 0) {
                    await this.create_phases(
                        run_id,
                        specs.map((s) => ({ name: s.name })),
                    );
                    return;
                }
            }
            const team = await Team.findByPk(team_id, { attributes: ['manifest'] });
            const names = phase_names_from_manifest(team?.manifest);
            if (names.length > 0) {
                await this.create_phases(
                    run_id,
                    names.map((name) => ({ name })),
                );
            }
        } catch {
            /* best-effort — update_status can still create rows later */
        }
    }

    /**
     * Re-register path: do not restamp team_version_id (older runs must
     * keep the workflow they started on). Seed only when no phase rows.
     */
    private static async _ensure_phases_seeded(
        run_id: string,
        team_id: string,
    ): Promise<void> {
        try {
            const count = await RunPhase.count({ where: { run_id } });
            if (count > 0) return;

            const stamped = await this.load_team_version_id(run_id);
            if (stamped) {
                const version = await this._resolve_team_version(team_id, stamped);
                if (version) {
                    const specs = this._specs_from_version_row(version);
                    if (specs.length > 0) {
                        await this.create_phases(
                            run_id,
                            specs.map((s) => ({ name: s.name })),
                        );
                        return;
                    }
                }
            }
            await this._stamp_version_and_seed(run_id, team_id);
        } catch {
            /* best-effort */
        }
    }

    static async get_by_name(name: string) {
        return Run.findOne({
            where: { run_name: name },
            order: [['started_at', 'DESC']],
        }) ?? null;
    }

    static async resolve(ref: string) {
        const by_id = await Run.findByPk(ref);
        if (by_id) return by_id;

        return Run.findOne({
            where: { run_name: ref },
            order: [['started_at', 'DESC']],
        }) ?? null;
    }

    /**
     * Fire one lifecycle event onto the Hub event bus for a run
     * transition (run.started, run.completed, run.failed, run.crashed,
     * run.cancelled, phase.input_required, phase.inputs_supplied).
     *
     * Best-effort. This is the ONLY way lifecycle events reach the bus
     * — callers must not emit directly, so we keep dedup / gating logic
     * in one place. If the run has been deleted between the transition
     * and this call we silently skip (nothing to attribute the event
     * to). Errors are swallowed because a broken bus mustn't take down
     * a run write.
     *
     * See DESIGN-jira-forge-plugin slice 1.3.
     *
     * Not `private` because run_reaper.service.ts calls this directly
     * for its RETURNING-based bulk crash path — cross-service use of
     * the same lifecycle emission is a feature, not a leak.
     */
    static async _emit_lifecycle(
        run_id: string,
        type: EventType,
        extra?: { error?: string | null; message?: string; payload?: Record<string, unknown> },
    ): Promise<void> {
        try {
            const row = await Run.findByPk(run_id, {
                attributes: ['run_id', 'realm_id', 'daemon_id', 'run_name', 'team_id', 'current_phase'],
            });
            if (!row) return;

            // event_submit_schema requires realm_id + daemon_id for run.*
            // and additionally `phase` for phase.*. A run that hasn't been
            // attributed to a realm yet (ambiguous daemon → NULL realm)
            // or that has no daemon has nothing useful for JIRA/Slack to
            // route to. Silently skip rather than log noisy schema errors
            // per lifecycle transition.
            if (!row.realm_id || !row.daemon_id) return;
            const is_phase = type.startsWith('phase.');
            if (is_phase && !row.current_phase) return;

            const payload: Record<string, unknown> = {
                run_name: row.run_name,
                team_id: row.team_id,
            };
            if (row.current_phase) payload.phase = row.current_phase;
            if (extra?.error) payload.error = extra.error;
            if (extra?.payload) Object.assign(payload, extra.payload);

            await EventSubmitService.submit({
                type,
                realm_id: row.realm_id,
                run_id: row.run_id,
                daemon_id: row.daemon_id,
                phase: row.current_phase ?? undefined,
                message: extra?.message,
                payload,
            });
        } catch (err) {
            console.warn(
                `[RunService] emit ${type} for ${run_id} failed: ${(err as Error).message}`,
            );
        }
    }

    static async create(
        workspace_id: string,
        team_id: string,
        opts?: {
            /** When set (daemon state push), reuse the daemon's run_id. */
            run_id?: string;
            daemon_id?: string;
            /**
             * Absolute path on the daemon — when set, ensure Hub workspace
             * row (id-first, path-fallback) before creating the run.
             * Folded from former /v1/workspaces/upsert_by_path outbox.
             */
            workspace_path?: string;
            workspace_name?: string | null;
            /**
             * Realm this run is being created for. When omitted we
             * resolve it from the daemon's realm membership, but ONLY
             * when the daemon belongs to exactly one realm. Ambiguous
             * daemons leave realm_id NULL and the run stays invisible
             * to realm listings (safer than guessing wrong).
             */
            realm_id?: string;
            run_name?: string;
            parent_run_id?: string;
            parent_phase?: string;
            inputs?: RunInputs;
            external_id?: string;
            context_labels?: Record<string, string>;
            execution_type?: string;
        },
    ): Promise<string> {
        const run_id = opts?.run_id?.trim() || randomUUID();
        const now = Date.now();
        const inputs_json = opts?.inputs ? JSON.stringify(opts.inputs) : null;
        const run_name = opts?.run_name ?? generate_slug();
        const execution_type = opts?.execution_type ?? 'local';
        const context_labels_json = opts?.context_labels ? JSON.stringify(opts.context_labels) : null;

        const realm_id = opts?.realm_id
            ?? (opts?.daemon_id ? await RunService._resolve_realm_for_daemon(opts.daemon_id) : null);

        /** Ensure Hub workspace + team link (replaces separate outbox upsert/add_team). */
        const path = opts?.workspace_path?.trim();
        let resolved_workspace_id = workspace_id;
        if (path) {
            const { WorkspaceService } = await import('./workspace.service.js');
            const { record } = await WorkspaceService.upsert_by_path(
                path,
                opts?.workspace_name ?? null,
                opts?.daemon_id ?? null,
                workspace_id,
            );
            resolved_workspace_id = String(record.id);
            await WorkspaceService.add_team(resolved_workspace_id, team_id);
        }

        const existing = await Run.findByPk(run_id);
        if (existing) {
            const was_running = existing.state === 'running';
            await existing.update({
                workspace_id: resolved_workspace_id,
                team_id,
                daemon_id: opts?.daemon_id ?? existing.daemon_id,
                realm_id: realm_id ?? existing.realm_id,
                run_name: opts?.run_name ?? existing.run_name,
                state: 'running',
                execution_type,
                parent_run_id: opts?.parent_run_id ?? existing.parent_run_id,
                parent_phase: opts?.parent_phase ?? existing.parent_phase,
                inputs: inputs_json ?? existing.inputs,
                external_id: opts?.external_id ?? existing.external_id,
                context_labels: context_labels_json ?? existing.context_labels,
                error: null,
                completed_at: null,
                started_at: existing.started_at ?? now,
                lease_expires_at: lease_deadline('running'),
            });
            // Only fire run.started when we actually transition INTO
            // running. Idempotent re-registers from the daemon (state
            // already 'running') would double-emit otherwise, and JIRA
            // would post a spurious "run started" comment on every
            // re-register during a daemon restart or reconnect.
            if (!was_running) {
                await this._emit_lifecycle(run_id, 'run.started');
            }
            // Re-register: keep stamped team_version_id; seed only if empty.
            await this._ensure_phases_seeded(run_id, team_id);
            return run_id;
        }

        await Run.create({
            run_id,
            run_name,
            workspace_id: resolved_workspace_id,
            team_id,
            daemon_id: opts?.daemon_id ?? null,
            realm_id,
            state: 'running',
            execution_type,
            current_pid: null,
            current_phase: null,
            parent_run_id: opts?.parent_run_id ?? null,
            parent_phase: opts?.parent_phase ?? null,
            root_run_id: opts?.parent_run_id ? null : run_id,
            call_path: '[]',
            call_depth: 0,
            inputs: inputs_json,
            external_id: opts?.external_id ?? null,
            context_labels: context_labels_json,
            started_at: now,
            completed_at: null,
            error: null,
            lease_expires_at: lease_deadline('running'),
        });

        // Denormalize org_id from the realm for org-scoped queries.
        if (realm_id) {
            try {
                const { Realm } = await import('../models/index.js');
                const realm = await Realm.findByPk(realm_id, { attributes: ['org_id'] });
                if (realm?.org_id) {
                    await get_sequelize().query(
                        `UPDATE cliq."team_runs" SET "org_id" = $1 WHERE "run_id" = $2`,
                        { bind: [realm.org_id, run_id] },
                    );
                }
            } catch { /* best-effort — backfill migration covers existing rows */ }
        }

        // Stamp team_version_id + seed phase rows (replaces daemon create_many).
        await this._stamp_version_and_seed(run_id, team_id);

        await this._emit_lifecycle(run_id, 'run.started');
        return run_id;
    }

    /** Extend the Hub action lease (progress ack). No-op if run missing/terminal. */
    static async touch_lease(
        run_id: string,
        kind: 'running' | 'awaiting_input' = 'running',
    ): Promise<void> {
        await Run.update(
            { lease_expires_at: lease_deadline(kind) },
            { where: { run_id, state: { [Op.in]: ['running', 'awaiting_input'] } } },
        );
    }

    /**
     * Attribute a run to a realm via its daemon.
     * Only returns a value when the daemon is unambiguously a member of a
     * single realm. Multi-realm daemons return null — attribution stays
     * NULL rather than picking arbitrarily and leaking cross-realm.
     */
    private static async _resolve_realm_for_daemon(daemon_id: string): Promise<string | null> {
        const rows = await RealmMember.findAll({
            where: { member_type: 'daemon', member_id: daemon_id },
            attributes: ['realm_id'],
        });
        if (rows.length !== 1) return null;
        return rows[0].realm_id;
    }

    static async complete(run_id: string, state: 'completed' | 'failed' | 'cancelled' | 'crashed', error?: string) {
        // Gate on `state != target` so re-reporting the same terminal
        // state (idempotent daemon reconcile after Hub restart, retry
        // of an already-acked /v1/runs/complete, etc.) doesn't double
        // fire the lifecycle event.
        const [count] = await Run.update(
            {
                state,
                completed_at: Date.now(),
                error: error ?? null,
                lease_expires_at: null,
            },
            { where: { run_id, state: { [Op.ne]: state } } },
        );
        if (count > 0) {
            await this._emit_lifecycle(run_id, `run.${state}` as EventType, { error: error ?? null });
            // Drop pending input/verdict HUGs so the list and badge clear.
            const { HugReviewsService } = await import('./hug_reviews.service.js');
            await HugReviewsService.expire_pending_for_run(run_id).catch(() => {});
        }
    }

    static async set_awaiting_input(run_id: string) {
        // Only emit when we're actually transitioning INTO awaiting_input.
        // The daemon calls this every time a phase gates for inputs; if
        // the run was already parked we don't want to re-notify. The
        // event maps to `phase.input_required` because that's the
        // human-meaningful transition — the run itself is a container,
        // but a specific phase is what's blocking on input.
        const [count] = await Run.update(
            {
                state: 'awaiting_input',
                lease_expires_at: lease_deadline('awaiting_input'),
            },
            { where: { run_id, state: { [Op.ne]: 'awaiting_input' } } },
        );
        if (count > 0) {
            await this._emit_lifecycle(run_id, 'phase.input_required');
        }
    }

    static async resume(run_id: string) {
        // where clause already gates the update to only `awaiting_input`
        // rows, so rows-affected > 0 is a real transition.
        const [count] = await Run.update(
            {
                state: 'running',
                lease_expires_at: lease_deadline('running'),
            },
            { where: { run_id, state: 'awaiting_input' } },
        );
        if (count > 0) {
            await this._emit_lifecycle(run_id, 'phase.inputs_supplied');
        }
    }

    static async restart(run_id: string) {
        await Run.update(
            {
                state: 'running',
                error: null,
                completed_at: null,
                lease_expires_at: lease_deadline('running'),
            },
            { where: { run_id, state: { [Op.in]: ['completed', 'failed', 'crashed', 'cancelled'] } } },
        );
    }

    static async set_inputs(run_id: string, inputs: RunInputs) {
        await Run.update(
            { inputs: JSON.stringify(inputs) },
            { where: { run_id } },
        );
    }

    static async set_current_pid(run_id: string, pid: number, phase: string) {
        await Run.update(
            { current_pid: pid, current_phase: phase },
            { where: { run_id } },
        );
    }

    static async clear_current_pid(run_id: string) {
        await Run.update(
            { current_pid: null, current_phase: null },
            { where: { run_id } },
        );
    }

    static async crash_stale(daemon_id?: string): Promise<number> {
        const where: Record<string, unknown> = { state: 'running' };
        if (daemon_id) where.daemon_id = daemon_id;
        // Select first so we can emit run.crashed per affected row.
        // Bulk UPDATE ... RETURNING would be cheaper but Sequelize
        // doesn't expose it uniformly across dialects; this path is
        // rarely-hit (daemon-restart) so the extra SELECT is fine.
        const stale = await Run.findAll({
            where,
            attributes: ['run_id'],
        });
        if (stale.length === 0) return 0;
        const [count] = await Run.update(
            { state: 'crashed', completed_at: Date.now(), error: 'daemon restarted' },
            { where },
        );
        for (const row of stale) {
            await this._emit_lifecycle(row.run_id, 'run.crashed', { error: 'daemon restarted' });
        }
        return count;
    }

    static async delete_by_workspace(workspace_id: string): Promise<number> {
        return Run.destroy({ where: { workspace_id } });
    }

    static async list_children(parent_run_id: string) {
        return Run.findAll({
            where: { parent_run_id },
            order: [['started_at', 'ASC']],
        });
    }

    static async list_active(workspace_id: string) {
        return Run.findAll({
            where: { workspace_id, state: 'running' },
            order: [['started_at', 'DESC']],
        });
    }

    // ── Events ─────────────────────────────────────────────────────

    static async append_event(
        run_id: string,
        type: string,
        phase?: string,
        agent?: string,
        payload?: unknown,
    ): Promise<string> {
        const record = await RunEvent.create({
            run_id,
            event_type: type,
            phase: phase ?? null,
            agent: agent ?? null,
            payload_json: payload ? JSON.stringify(payload) : null,
            created_at: next_event_created_at_ms(),
        });
        return String(record.get('id'));
    }

    static async list_events(run_id: string) {
        return RunEvent.findAll({
            where: { run_id },
            order: [['created_at', 'ASC'], ['id', 'ASC']],
        });
    }

    static async list_events_after(run_id: string, after_id: string) {
        const cursor = await RunEvent.findByPk(after_id);
        if (!cursor || String(cursor.get('run_id')) !== run_id) {
            return RunService.list_events(run_id);
        }
        const created_at = Number(cursor.get('created_at'));
        const cursor_id = String(cursor.get('id'));
        // Same-ms inserts share created_at; tie-break on id so the cursor is stable.
        return RunEvent.findAll({
            where: {
                run_id,
                [Op.or]: [
                    { created_at: { [Op.gt]: created_at } },
                    { created_at, id: { [Op.gt]: cursor_id } },
                ],
            },
            order: [['created_at', 'ASC'], ['id', 'ASC']],
        });
    }

    static async count_events(run_id: string): Promise<number> {
        return RunEvent.count({ where: { run_id } });
    }

    static async delete_events(run_id: string): Promise<number> {
        return RunEvent.destroy({ where: { run_id } });
    }

    // ── Logs ───────────────────────────────────────────────────────

    static async append_log(
        run_id: string,
        chunk: string,
        opts: { concern?: string } = {},
    ): Promise<string | null> {
        const current_size = await RunService.log_size(run_id);
        if (current_size + chunk.length > MAX_LOG_SIZE_BYTES) return null;

        const created_at = Date.now();
        const record = await RunLog.create({
            run_id,
            chunk,
            created_at,
        });
        const chunk_id = String(record.get('id'));

        const concern = opts.concern?.trim() || 'run';

        try {
            await RunService._index_log_lines(run_id, chunk, created_at, chunk_id, concern);
        } catch (err) {
            // Chunk is durable; line index is best-effort for explorer.
            console.warn(`[RunService] log line index failed for ${run_id}: ${(err as Error).message}`);
        }

        return chunk_id;
    }

    /** Split chunk into searchable run_log_lines rows. */
    private static async _index_log_lines(
        run_id: string,
        chunk: string,
        created_at: number,
        chunk_id: string,
        concern: string,
    ): Promise<void> {
        const lines = split_log_chunk(chunk);
        if (lines.length === 0) return;

        const run = await Run.findByPk(run_id);
        const daemon_id = run?.daemon_id ?? null;
        const workspace_id = run?.workspace_id ?? null;
        let team: string | null = null;
        if (run?.team_id) {
            const team_row = await Team.findByPk(run.team_id, {
                attributes: ['id', 'slug', 'scope_id'],
                include: [{ model: Scope, as: 'scope', attributes: ['slug'] }],
            });
            if (team_row) {
                const plain = team_row.toJSON() as {
                    slug?: string;
                    scope?: { slug?: string };
                };
                team = plain.scope?.slug
                    ? `@${plain.scope.slug}/${plain.slug}`
                    : (plain.slug ?? run.team_id);
            }
        }

        let realm_id: string | null = null;
        if (daemon_id) {
            const membership = await RealmMember.findOne({
                where: { member_type: 'daemon', member_id: daemon_id },
                attributes: ['realm_id'],
                order: [['created_at', 'ASC']],
            });
            realm_id = membership?.realm_id ?? null;
        }

        await RunLogLine.bulkCreate(
            lines.map((message) => ({
                id: randomUUID(),
                run_id,
                created_at,
                level: parse_log_level(message),
                message,
                daemon_id,
                workspace_id,
                team,
                realm_id,
                chunk_id,
                concern,
            })),
        );
    }

    /**
     * Datadog-style log line search for a realm (paginated + facet counts).
     */
    static async search_log_lines(opts: {
        realm_id?: string;
        q?: string;
        levels?: string[];
        run_ids?: string[];
        daemon_ids?: string[];
        workspace_ids?: string[];
        teams?: string[];
        concerns?: string[];
        since_ms?: number;
        until_ms?: number;
        offset?: number;
        limit?: number;
    }): Promise<{
        lines: Array<{
            id: string;
            run_id: string;
            run_name: string | null;
            created_at: number;
            level: string;
            message: string;
            daemon_id: string | null;
            daemon_name: string | null;
            workspace_id: string | null;
            workspace_name: string | null;
            team: string | null;
            realm_id: string | null;
            concern: string | null;
        }>;
        total: number;
        facets: {
            level: Array<{ value: string; label?: string; count: number }>;
            daemon_id: Array<{ value: string; label?: string; count: number }>;
            team: Array<{ value: string; label?: string; count: number }>;
            run_id: Array<{ value: string; label?: string; count: number }>;
            workspace_id: Array<{ value: string; label?: string; count: number }>;
            concern: Array<{ value: string; label?: string; count: number }>;
        };
        realm: { id: string; name: string | null; slug: string | null };
    }> {
        const where: Record<string, unknown> = {};
        if (opts.realm_id) where.realm_id = opts.realm_id;
        if (opts.levels?.length) where.level = { [Op.in]: opts.levels };
        if (opts.run_ids?.length) where.run_id = { [Op.in]: opts.run_ids };
        if (opts.daemon_ids?.length) where.daemon_id = { [Op.in]: opts.daemon_ids };
        if (opts.workspace_ids?.length) where.workspace_id = { [Op.in]: opts.workspace_ids };
        if (opts.teams?.length) where.team = { [Op.in]: opts.teams };
        if (opts.concerns?.length) where.concern = { [Op.in]: opts.concerns };
        if (opts.since_ms != null || opts.until_ms != null) {
            const created: Record<string | symbol, number> = {};
            if (opts.since_ms != null) created[Op.gte] = opts.since_ms;
            if (opts.until_ms != null) created[Op.lte] = opts.until_ms;
            where.created_at = created;
        }
        const q = opts.q?.trim();
        if (q) {
            where.message = { [Op.iLike]: `%${q}%` };
        }

        const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
        const offset = Math.max(0, opts.offset ?? 0);

        const total = await RunLogLine.count({ where });
        const rows = await RunLogLine.findAll({
            where,
            order: [['created_at', 'DESC']],
            limit,
            offset,
        });

        const facet_counts = async (
            field: 'level' | 'daemon_id' | 'team' | 'run_id' | 'workspace_id' | 'concern',
        ): Promise<Array<{ value: string; count: number }>> => {
            const facet_where: Record<string, unknown> = { ...where };
            delete facet_where[field];
            const grouped = await RunLogLine.findAll({
                attributes: [
                    field,
                    [get_sequelize().fn('COUNT', get_sequelize().col('*')), 'count'],
                ],
                where: {
                    ...facet_where,
                    [field]: { [Op.ne]: null },
                },
                group: [field],
                order: [[get_sequelize().literal('count'), 'DESC']],
                limit: 40,
                raw: true,
            }) as unknown as Array<Record<string, unknown>>;

            return grouped
                .map((r) => ({
                    value: String(r[field] ?? ''),
                    count: Number(r.count ?? 0),
                }))
                .filter((r) => r.value);
        };

        const [level, daemon_id_facets, team, run_id_facets, workspace_id_facets, concern_facets] = await Promise.all([
            facet_counts('level'),
            facet_counts('daemon_id'),
            facet_counts('team'),
            facet_counts('run_id'),
            facet_counts('workspace_id'),
            facet_counts('concern'),
        ]);

        const run_ids = [...new Set([
            ...rows.map((r) => r.run_id),
            ...run_id_facets.map((f) => f.value),
        ].filter(Boolean))];
        const daemon_ids = [...new Set([
            ...rows.map((r) => r.daemon_id).filter((v): v is string => Boolean(v)),
            ...daemon_id_facets.map((f) => f.value),
        ])];
        const workspace_ids = [...new Set([
            ...rows.map((r) => r.workspace_id).filter((v): v is string => Boolean(v)),
            ...workspace_id_facets.map((f) => f.value),
        ])];

        const [runs, daemons, workspaces, realm_row] = await Promise.all([
            run_ids.length
                ? Run.findAll({ where: { run_id: { [Op.in]: run_ids } }, attributes: ['run_id', 'run_name'] })
                : Promise.resolve([]),
            daemon_ids.length
                ? Daemon.findAll({ where: { id: { [Op.in]: daemon_ids } }, attributes: ['id', 'name', 'hostname'] })
                : Promise.resolve([]),
            workspace_ids.length
                ? Workspace.findAll({ where: { id: { [Op.in]: workspace_ids } }, attributes: ['id', 'name'] })
                : Promise.resolve([]),
            opts.realm_id
                ? Realm.findByPk(opts.realm_id, { attributes: ['id', 'name', 'slug'] })
                : Promise.resolve(null),
        ]);

        const run_name_by_id = new Map(
            runs.map((r) => [String(r.get('run_id')), String(r.get('run_name') ?? '').trim() || null]),
        );
        const daemon_name_by_id = new Map(
            daemons.map((d) => {
                const name = String(d.get('name') ?? '').trim()
                    || String(d.get('hostname') ?? '').trim()
                    || null;
                return [String(d.get('id')), name] as const;
            }),
        );
        const workspace_name_by_id = new Map(
            workspaces.map((w) => [
                String(w.get('id')),
                String(w.get('name') ?? '').trim() || null,
            ]),
        );

        const short_id = (id: string) => (id.length > 8 ? `${id.slice(0, 8)}…` : id);
        const labeled = (
            id: string,
            name: string | null,
        ): { value: string; label: string; count?: number } => ({
            value: id,
            label: name ? `${name} (${short_id(id)})` : short_id(id),
        });

        return {
            lines: rows.map((r) => ({
                id: r.id,
                run_id: r.run_id,
                run_name: run_name_by_id.get(r.run_id) ?? null,
                created_at: Number(r.created_at),
                level: r.level,
                message: r.message,
                daemon_id: r.daemon_id,
                daemon_name: r.daemon_id ? (daemon_name_by_id.get(r.daemon_id) ?? null) : null,
                workspace_id: r.workspace_id,
                workspace_name: r.workspace_id
                    ? (workspace_name_by_id.get(r.workspace_id) ?? null)
                    : null,
                team: r.team,
                realm_id: r.realm_id,
                concern: r.concern,
            })),
            total,
            facets: {
                level,
                daemon_id: daemon_id_facets.map((f) => ({
                    ...f,
                    label: labeled(f.value, daemon_name_by_id.get(f.value) ?? null).label,
                })),
                team,
                run_id: run_id_facets.map((f) => ({
                    ...f,
                    label: labeled(f.value, run_name_by_id.get(f.value) ?? null).label,
                })),
                workspace_id: workspace_id_facets.map((f) => ({
                    ...f,
                    label: labeled(f.value, workspace_name_by_id.get(f.value) ?? null).label,
                })),
                concern: concern_facets,
            },
            realm: {
                id: opts.realm_id ?? '*',
                name: opts.realm_id
                    ? (realm_row ? String(realm_row.get('name') ?? '').trim() || null : null)
                    : 'All realms',
                slug: opts.realm_id
                    ? (realm_row ? String(realm_row.get('slug') ?? '').trim() || null : null)
                    : null,
            },
        };
    }


    static async get_log(run_id: string): Promise<string> {
        const rows = await RunLog.findAll({
            where: { run_id },
            attributes: ['chunk'],
            order: [['created_at', 'ASC'], ['id', 'ASC']],
        });
        return rows.map((r) => r.get('chunk') as string).join('');
    }

    static async get_log_chunks(run_id: string, after_id?: string | null, limit = 100) {
        const rows = await RunLog.findAll({
            where: { run_id },
            order: [['created_at', 'ASC'], ['id', 'ASC']],
        });
        if (!after_id) {
            return rows.slice(0, limit);
        }
        const cursor_idx = rows.findIndex((r) => String(r.get('id')) === String(after_id));
        // Unknown cursor → return from the start (same as missing after_id callers expect).
        if (cursor_idx < 0) {
            return rows.slice(0, limit);
        }
        return rows.slice(cursor_idx + 1, cursor_idx + 1 + limit);
    }

    static async log_size(run_id: string): Promise<number> {
        const sequelize = get_sequelize();
        const [results] = await sequelize.query(
            'SELECT COALESCE(SUM(LENGTH(chunk)), 0) AS total FROM cliq.run_logs WHERE run_id = $1',
            { bind: [run_id] },
        );
        const row = (results as unknown as Array<{ total: string }>)[0];
        return Number(row?.total ?? 0);
    }

    static async delete_logs(run_id: string): Promise<number> {
        await RunLogLine.destroy({ where: { run_id } });
        return RunLog.destroy({ where: { run_id } });
    }

    static async purge_logs(days: number): Promise<number> {
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        const sequelize = get_sequelize();
        const [, meta] = await sequelize.query(
            `DELETE FROM run_logs WHERE run_id IN (
                SELECT run_id FROM team_runs
                WHERE completed_at IS NOT NULL AND completed_at < ?
            )`,
            { replacements: [cutoff] },
        );
        return (meta as number) ?? 0;
    }

    // ── Phases ─────────────────────────────────────────────────────

    static async create_phases(run_id: string, phases: ReadonlyArray<{ name: string; agent?: string }>) {
        if (phases.length === 0) return;

        const sequelize = get_sequelize();
        const tx = await sequelize.transaction();
        try {
            for (let i = 0; i < phases.length; i++) {
                const p = phases[i]!;
                const [row, created] = await RunPhase.findOrCreate({
                    where: { run_id, phase: p.name },
                    defaults: {
                        run_id,
                        phase: p.name,
                        status: 'pending',
                        agent_name: p.agent ?? null,
                        attempt: 0,
                        sequence: i,
                    },
                    transaction: tx,
                });
                if (!created && Number((row as { sequence?: number }).sequence ?? -1) !== i) {
                    await row.update({ sequence: i }, { transaction: tx });
                }
            }
            await tx.commit();
        } catch (err) {
            await tx.rollback();
            throw err;
        }
    }

    /**
     * Resolve YAML workflow order for a run. Prefers the run's team row;
     * if that team was deleted, finds any team whose manifest covers the
     * phase names (tightest match). Timestamp-based sequence is unreliable.
     */
    private static async workflow_order_for_run(
        run_id: string,
        phase_names: readonly string[],
    ): Promise<string[] | null> {
        const specs = await this.workflow_specs_for_run(run_id, phase_names);
        if (specs.length === 0) return null;
        return specs.map((s) => s.name);
    }

    /**
     * Resolve enriched phase specs (name, phase_type, depends_on) for a
     * run. Prefers the stamped team_version_id workflow, then the team's
     * cliq.teams.manifest, then a tightest-match scan of all teams for
     * orphaned runs whose team row was deleted.
     */
    private static async workflow_specs_for_run(
        run_id: string,
        phase_names: readonly string[],
    ): Promise<PhaseManifestSpec[]> {
        if (phase_names.length === 0) return [];

        const run = await Run.findByPk(run_id, { attributes: ['team_id'] });
        const team_id = run?.team_id ?? null;

        if (team_id) {
            const version_id = await this.load_team_version_id(run_id);
            if (version_id) {
                const version = await this._resolve_team_version(team_id, version_id);
                if (version) {
                    const specs = this._specs_from_version_row(version);
                    if (specs.length > 0) return specs;
                }
            }
            const team = await Team.findByPk(team_id, { attributes: ['manifest'] });
            const specs = phase_specs_from_manifest(team?.manifest);
            if (specs.length > 0) return specs;
        }

        const needed = new Set(phase_names);
        const teams = await Team.findAll({ attributes: ['manifest'], limit: 1_000 });
        let best: PhaseManifestSpec[] = [];
        for (const t of teams) {
            const specs = phase_specs_from_manifest(t.manifest);
            if (specs.length === 0) continue;
            const names = specs.map((s) => s.name);
            if (![...needed].every((n) => names.includes(n))) continue;
            if (best.length === 0 || specs.length < best.length) best = specs;
        }
        return best;
    }

    /** Sort + repair stored sequence to match team YAML when available. */
    private static async order_phase_rows(
        run_id: string,
        rows: InstanceType<typeof RunPhase>[],
    ): Promise<InstanceType<typeof RunPhase>[]> {
        if (rows.length <= 1) return rows;
        const order = await this.workflow_order_for_run(
            run_id,
            rows.map((r) => r.phase),
        );
        if (!order || order.length === 0) return rows;

        const sorted = sort_phases_by_workflow(rows, order);
        await Promise.all(
            sorted.map(async (row, i) => {
                const current = Number(row.getDataValue('sequence') ?? 0);
                if (current === i) return;
                try {
                    await row.update({ sequence: i });
                } catch {
                    /* column may be missing */
                }
            }),
        );
        return sorted;
    }

    static async list_phases(run_id: string) {
        let rows: InstanceType<typeof RunPhase>[];
        try {
            rows = await RunPhase.findAll({
                where: { run_id },
                order: [
                    ['sequence', 'ASC'],
                    ['started_at', 'ASC'],
                    ['phase', 'ASC'],
                ],
            });
        } catch {
            // Pre-migrate DBs missing sequence — still return phases.
            rows = await RunPhase.findAll({
                where: { run_id },
                attributes: { exclude: ['sequence'] },
                order: [
                    ['started_at', 'ASC'],
                    ['dispatched_at', 'ASC'],
                    ['phase', 'ASC'],
                ],
            });
        }
        const ordered = await this.order_phase_rows(run_id, rows);
        return this._enrich_phase_rows(run_id, ordered);
    }

    static async find_phase(run_id: string, phase: string) {
        return RunPhase.findOne({ where: { run_id, phase } });
    }

    static async list_phases_by_status(run_id: string, status: string) {
        let rows: InstanceType<typeof RunPhase>[];
        try {
            rows = await RunPhase.findAll({
                where: { run_id, status },
                order: [
                    ['sequence', 'ASC'],
                    ['started_at', 'ASC'],
                    ['phase', 'ASC'],
                ],
            });
        } catch {
            rows = await RunPhase.findAll({
                where: { run_id, status },
                attributes: { exclude: ['sequence'] },
                order: [
                    ['started_at', 'ASC'],
                    ['dispatched_at', 'ASC'],
                    ['phase', 'ASC'],
                ],
            });
        }
        const ordered = await this.order_phase_rows(run_id, rows);
        return this._enrich_phase_rows(run_id, ordered);
    }

    /**
     * Merge the team manifest's structural info (phase_type, depends_on,
     * max_iterations) into each stored phase row and expose an extra
     * `name` alias.
     *
     * `team_run_phases` only persists the ephemeral run-time state
     * (phase, status, timings, agent) — not the workflow shape. The
     * observability DAG needs `phase_type` and `depends_on` to lay out
     * nodes; without them every phase collapses into a single invisible
     * layer. Reading the manifest once per list call is cheap (already
     * cached in workflow_specs_for_run's team fetch).
     *
     * Backward compat: original DB columns (`phase`, `status`, …) are
     * preserved so existing consumers (run_phases_panel, logs) continue
     * to work unchanged.
     */
    private static async _enrich_phase_rows(
        run_id: string,
        rows: InstanceType<typeof RunPhase>[],
    ) {
        const names = rows.map((r) => String(r.getDataValue('phase') ?? ''));
        const specs = await this.workflow_specs_for_run(run_id, names);
        const spec_by_name = new Map(specs.map((s) => [s.name, s]));

        // Load previous_attempts via raw SQL — the store's RunPhase
        // model doesn't declare the column (it's Hub-side history), so
        // ORM `.findAll` won't project it even though the migration
        // added it. Kept best-effort so a fresh DB missing the column
        // doesn't 500 the whole page.
        const history_by_phase = new Map<string, unknown[]>();
        try {
            const sq = get_sequelize();
            const rows_hist = await sq.query<{ phase: string; previous_attempts: unknown }>(
                `SELECT "phase", "previous_attempts"
                   FROM cliq."team_run_phases"
                  WHERE "run_id" = :run_id`,
                { replacements: { run_id }, type: QueryTypes.SELECT },
            );
            for (const row of rows_hist) {
                const raw = row.previous_attempts;
                const arr = Array.isArray(raw)
                    ? raw
                    : (typeof raw === 'string' ? _safe_parse_array(raw) : []);
                if (arr.length > 0) history_by_phase.set(row.phase, arr);
            }
        } catch {
            /* pre-migration DB — history stays empty */
        }

        return rows.map((row, i) => {
            const base = row.get({ plain: true }) as unknown as Record<string, unknown>;
            const phase_name = String(base['phase'] ?? '');
            const spec = spec_by_name.get(phase_name);
            // Fallback: synthesize a linear dep chain from ordering when
            // no manifest is available (orphan runs whose team was
            // deleted). Preserves the DAG shape for a purely sequential
            // workflow — parallel/branching phases will just look linear.
            const fallback_deps = i > 0
                ? [String(rows[i - 1].getDataValue('phase') ?? '')]
                : [];
            return {
                ...base,
                name: phase_name,
                phase_type: spec?.phase_type ?? 'standard',
                depends_on: spec?.depends_on ?? fallback_deps,
                previous_attempts: history_by_phase.get(phase_name) ?? [],
                ...(spec?.max_iterations !== undefined
                    ? { max_iterations: spec.max_iterations }
                    : {}),
            };
        });
    }

    static async update_phase_status(
        run_id: string,
        phase: string,
        status: string,
        extra?: {
            exit_code?: number | null;
            error?: string | null;
            dispatched_at?: number | null;
            started_at?: number | null;
        },
    ) {
        // Snapshot the prior attempt into previous_attempts whenever we
        // start a *new* attempt (pending → running) after a terminal
        // one. Without this the chart loses everything the previous
        // run recorded the moment the daemon reissues `dispatched_at`.
        if (status === 'running') {
            await RunService._snapshot_prior_attempt(run_id, phase);
        }

        const updates: Record<string, unknown> = { status };
        if (['done', 'failed', 'skipped'].includes(status)) {
            updates.completed_at = Date.now();
        }
        if (status === 'running') {
            updates.dispatched_at = Date.now();
            // Fresh attempt: null out started_at/completed_at/exit_code/error
            // so a stale "failed" summary doesn't leak into the running row.
            updates.started_at = null;
            updates.completed_at = null;
            updates.exit_code = null;
            updates.error = null;
        }
        if (extra) Object.assign(updates, extra);

        const [affected] = await RunPhase.update(updates, { where: { run_id, phase } });
        // First status for a phase that wasn't seeded (edge case): insert then apply.
        if (affected === 0) {
            await RunPhase.findOrCreate({
                where: { run_id, phase },
                defaults: {
                    run_id,
                    phase,
                    status: 'pending',
                    agent_name: null,
                    attempt: 0,
                    sequence: 0,
                },
            });
            await RunPhase.update(updates, { where: { run_id, phase } });
        }
        // Phase progress renews the Hub action lease.
        await RunService.touch_lease(run_id, 'running');
    }

    /**
     * Batch phase status updates (1..N). Replaces
     * `/v1/runs/phases/update_status` (single) with `/v1/runs/update_status`.
     */
    static async update_phases_status(
        run_id: string,
        phases: ReadonlyArray<{
            phase: string;
            status: string;
            exit_code?: number | null;
            error?: string | null;
            dispatched_at?: number | null;
            started_at?: number | null;
        }>,
    ): Promise<void> {
        for (const p of phases) {
            const { phase, status, ...extra } = p;
            await this.update_phase_status(run_id, phase, status, extra);
        }
    }

    static async reset_phase(run_id: string, phase: string) {
        // Same snapshot-then-clear as update_phase_status(running) so
        // the timeline keeps every prior attempt across resume boundaries.
        await RunService._snapshot_prior_attempt(run_id, phase);
        await RunPhase.update(
            {
                status: 'pending',
                dispatched_at: null,
                started_at: null,
                completed_at: null,
                exit_code: null,
                error: null,
            },
            { where: { run_id, phase } },
        );
    }

    /**
     * Push the phase's current attempt-summary onto `previous_attempts`
     * if it has any real timing (dispatched_at OR started_at OR
     * completed_at). No-op when the phase is still pristine — avoids
     * seeding a `[null,null,null]` row on the very first `running`.
     *
     * Uses jsonb_insert-style array_append so concurrent updaters can't
     * clobber each other's history the way a read-modify-write would.
     */
    private static async _snapshot_prior_attempt(run_id: string, phase: string): Promise<void> {
        const row = await RunPhase.findOne({
            where: { run_id, phase },
            attributes: ['status', 'dispatched_at', 'started_at', 'completed_at', 'exit_code', 'error', 'attempt'],
        });
        if (!row) return;
        const dispatched_at = row.get('dispatched_at') as number | null;
        const started_at = row.get('started_at') as number | null;
        const completed_at = row.get('completed_at') as number | null;
        if (dispatched_at == null && started_at == null && completed_at == null) return;

        const snapshot = {
            attempt: (row.get('attempt') as number | null) ?? 0,
            status: row.get('status') as string,
            dispatched_at,
            started_at,
            completed_at,
            exit_code: (row.get('exit_code') as number | null) ?? null,
            error: (row.get('error') as string | null) ?? null,
        };

        const sq = get_sequelize();
        // jsonb `COALESCE("previous_attempts", '[]') || :snap` — atomic
        // append avoids the read-modify-write race two concurrent
        // resume-then-run flows would otherwise trigger.
        await sq.query(
            `UPDATE cliq."team_run_phases"
                SET "previous_attempts" = COALESCE("previous_attempts", '[]'::jsonb) || :snap::jsonb
              WHERE "run_id" = :run_id AND "phase" = :phase`,
            {
                replacements: {
                    run_id,
                    phase,
                    snap: JSON.stringify([snapshot]),
                },
            },
        );
    }

    static async delete_phases(run_id: string): Promise<number> {
        return RunPhase.destroy({ where: { run_id } });
    }

    // ── Artifacts ──────────────────────────────────────────────────

    /**
     * Upsert by (run_id, phase, kind, name). Daemon mirrors replace
     * phase_output / chat_transcript the same way locally; outbox
     * retries must not stack duplicate Hub rows for HUG.
     */
    static async create_artifact(data: {
        run_id: string;
        phase: string;
        kind: string;
        name: string;
        content: string;
        mime_type?: string;
        target_phase?: string;
        sequence?: number;
    }): Promise<string> {
        await RunArtifact.destroy({
            where: {
                run_id: data.run_id,
                phase: data.phase,
                kind: data.kind,
                name: data.name,
            },
        });
        const record = await RunArtifact.create({
            run_id: data.run_id,
            phase: data.phase,
            kind: data.kind,
            name: data.name,
            content: data.content,
            mime_type: data.mime_type ?? null,
            target_phase: data.target_phase ?? null,
            sequence: data.sequence ?? null,
            created_at: Date.now(),
        });
        return String(record.get('id'));
    }

    static async append_handoff(
        run_id: string,
        from: string,
        to: string,
        name: string,
        content: string,
    ): Promise<string> {
        const sequelize = get_sequelize();
        const tx = await sequelize.transaction();
        try {
            const [seq_results] = await sequelize.query(
                `SELECT COALESCE(MAX(sequence), -1) + 1 AS next_seq
                   FROM cliq.run_artifacts
                  WHERE run_id = $1 AND phase = $2 AND target_phase = $3 AND kind = 'handoff'`,
                { bind: [run_id, from, to], transaction: tx },
            );
            const seq_row = (seq_results as unknown as Array<{ next_seq: number }>)[0];

            const record = await RunArtifact.create({
                run_id,
                phase: from,
                kind: 'handoff',
                name,
                content,
                mime_type: null,
                target_phase: to,
                sequence: seq_row.next_seq,
                created_at: Date.now(),
            }, { transaction: tx });

            await tx.commit();
            return String(record.get('id'));
        } catch (err) {
            await tx.rollback();
            throw err;
        }
    }

    static async list_artifacts_by_phase(run_id: string, phase: string) {
        return RunArtifact.findAll({
            where: { run_id, phase },
            order: [['id', 'ASC']],
        });
    }

    static async list_artifacts_by_kind(run_id: string, kind: string) {
        return RunArtifact.findAll({
            where: { run_id, kind },
            order: [['id', 'ASC']],
        });
    }

    static async list_handoffs_for(run_id: string, target_phase: string) {
        return RunArtifact.findAll({
            where: { run_id, target_phase, kind: 'handoff' },
            order: [['sequence', 'ASC'], ['id', 'ASC']],
        });
    }

    static async list_artifacts(run_id: string) {
        return RunArtifact.findAll({
            where: { run_id },
            order: [['id', 'ASC']],
        });
    }

    static async delete_artifacts(run_id: string): Promise<number> {
        return RunArtifact.destroy({ where: { run_id } });
    }

    // ── Usage snapshot ingestion ─────────────────────────────────────

    /**
     * Ingest a usage snapshot from the daemon (via outbox).
     *
     * Enriches token-only data with cost_usd from the pricing service,
     * then writes the enriched snapshot to the appropriate JSONB column.
     */
    static async ingest_usage_snapshot(
        snapshot: UsageSnapshotPayload,
        pricing_service: import('./model_pricing.service.js').ModelPricingService,
    ): Promise<void> {
        const sq = get_sequelize();

        // Enrich by_model entries with cost_usd.
        let total_cost_usd = 0;
        const enriched_by_model: Record<string, unknown> = {};

        for (const [key, model] of Object.entries(snapshot.by_model ?? {})) {
            const resolved = pricing_service.resolve_cost(
                model.provider,
                model.model,
                model.tokens_in,
                model.tokens_out,
            );
            const cost = resolved?.cost_usd ?? null;
            if (cost !== null) total_cost_usd += cost;
            enriched_by_model[key] = { ...model, cost_usd: cost };
        }

        const enriched = {
            ...snapshot,
            by_model: enriched_by_model,
            total_cost_usd,
        };

        const snapshot_json = JSON.stringify(enriched);

        if (snapshot.snapshot_type === 'run') {
            await sq.query(
                `UPDATE cliq.team_runs SET usage_snapshot = :snapshot WHERE run_id = :run_id`,
                { replacements: { snapshot: snapshot_json, run_id: snapshot.run_id } },
            );
            return;
        }

        // Phase-level snapshot.
        if (!snapshot.phase) return;
        await sq.query(
            `UPDATE cliq.team_run_phases SET usage_snapshot = :snapshot
             WHERE run_id = :run_id AND phase = :phase`,
            { replacements: { snapshot: snapshot_json, run_id: snapshot.run_id, phase: snapshot.phase } },
        );
    }

    /**
     * Retrieve usage snapshots for a run — run-level plus all phases.
     */
    static async get_usage(run_id: string): Promise<{
        run: unknown;
        phases: Array<{ phase: string; usage_snapshot: unknown }>;
    }> {
        const sq = get_sequelize();

        const [run_rows] = await sq.query(
            `SELECT usage_snapshot FROM cliq.team_runs WHERE run_id = :run_id`,
            { replacements: { run_id } },
        ) as [Array<{ usage_snapshot: unknown }>, unknown];

        const [phase_rows] = await sq.query(
            `SELECT phase, usage_snapshot FROM cliq.team_run_phases
             WHERE run_id = :run_id ORDER BY sequence ASC`,
            { replacements: { run_id } },
        ) as [Array<{ phase: string; usage_snapshot: unknown }>, unknown];

        return {
            run: run_rows[0]?.usage_snapshot ?? null,
            phases: phase_rows.map((p) => ({
                phase: p.phase,
                usage_snapshot: p.usage_snapshot ?? null,
            })),
        };
    }

    // ── Event ingestion (Observability Phase 2c) ───────────────────────

    /**
     * Bulk-insert streaming events from a daemon and fan out to the
     * in-process event bus for SSE delivery.
     *
     * Returns the count of inserted events and the auto-assigned IDs.
     */
    static async ingest_events(
        run_id: string,
        daemon_id: string | null,
        realm_id: string | null,
        events: Array<{
            event_type: string;
            phase?: string | null;
            agent?: string | null;
            payload_json?: string | null;
            created_at: number;
        }>,
    ): Promise<{ count: number; ids: string[] }> {
        if (events.length === 0) return { count: 0, ids: [] };

        const sq = get_sequelize();
        const ids: string[] = [];

        // Bulk insert via a single multi-row INSERT with RETURNING id.
        const values_parts: string[] = [];
        const replacements: Record<string, unknown> = {
            run_id,
        };

        for (let i = 0; i < events.length; i++) {
            const e = events[i]!;
            const payload_key = `payload_${i}`;
            const ts_key = `ts_${i}`;
            const et_key = `et_${i}`;
            const ph_key = `ph_${i}`;
            const ag_key = `ag_${i}`;

            replacements[et_key] = e.event_type;
            replacements[ph_key] = e.phase ?? null;
            replacements[ag_key] = e.agent ?? null;
            replacements[payload_key] = e.payload_json ?? null;
            replacements[ts_key] = e.created_at;

            values_parts.push(
                `(:run_id, :${et_key}, :${ph_key}, :${ag_key}, :${payload_key}, :${ts_key})`,
            );
        }

        const query = `INSERT INTO cliq."team_run_events"
            ("run_id", "event_type", "phase", "agent", "payload_json", "created_at")
            VALUES ${values_parts.join(', ')}
            RETURNING "id"`;

        const [rows] = await sq.query(query, { replacements }) as [Array<{ id: string }>, unknown];
        for (const row of rows) {
            ids.push(String(row.id));
        }

        // Fan out to SSE subscribers via the in-process event bus.
        const { publish_run_event } = await import('./run_event_bus.js');
        for (let i = 0; i < events.length; i++) {
            const e = events[i]!;
            publish_run_event({
                id: ids[i]!,
                run_id,
                event_type: e.event_type,
                phase: e.phase ?? null,
                agent: e.agent ?? null,
                payload: e.payload_json ? JSON.parse(e.payload_json) : null,
                timestamp: e.created_at,
            });
        }

        // Event batch = liveness signal from the daemon. Refresh the
        // Hub action lease so long-running phases (30+ min LLM/parsing
        // work) don't get force-crashed by the run_reaper while the
        // daemon is happily streaming activity. Without this, only
        // phase-status transitions renew the lease, and any phase that
        // stays in `running` past RUN_LEASE_TTL_MS gets reaped even
        // though the daemon is still working.
        //
        // Cheap: single UPDATE with an indexed WHERE, gated to
        // running/awaiting_input rows only (no-op on terminal runs).
        await this.touch_lease(run_id, 'running').catch(() => {
            // Never fail an event ingest because of the lease refresh.
        });

        // Durable run-state side effects (replaces POST set_awaiting_input).
        // Idempotent: each helper only transitions when state actually changes.
        const types = new Set(events.map((e) => e.event_type));
        if (types.has('phase.input_required')) {
            await this.set_awaiting_input(run_id).catch(() => {});
        }
        if (types.has('phase.inputs_supplied')) {
            await this.resume(run_id).catch(() => {});
        }

        return { count: events.length, ids };
    }

    /**
     * Retrieve events for a run, optionally after a cursor id.
     * Used for SSE reconnect replay.
     */
    static async get_events(
        run_id: string,
        after_id?: string,
        limit = 1000,
    ): Promise<Array<{
        id: string;
        event_type: string;
        phase: string | null;
        agent: string | null;
        payload: unknown;
        timestamp: number;
    }>> {
        const sq = get_sequelize();
        let where_clause = `WHERE e."run_id" = :run_id`;
        const replacements: Record<string, unknown> = { run_id, limit };
        if (after_id) {
            where_clause += ` AND e."created_at" > (
                SELECT c."created_at" FROM cliq."team_run_events" c
                WHERE c."id" = :after_id AND c."run_id" = :run_id
            )`;
            replacements.after_id = after_id;
        }

        const [rows] = await sq.query(
            `SELECT e."id", e."event_type", e."phase", e."agent",
                    e."payload_json" AS "payload", e."created_at" AS "timestamp"
             FROM cliq."team_run_events" e
             ${where_clause}
             ORDER BY e."created_at" ASC, e."id" ASC
             LIMIT :limit`,
            { replacements },
        ) as [Array<{
            id: string;
            event_type: string;
            phase: string | null;
            agent: string | null;
            payload: string | null;
            timestamp: number;
        }>, unknown];

        return rows.map((r) => ({
            id: String(r.id),
            event_type: r.event_type,
            phase: r.phase,
            agent: r.agent,
            payload: r.payload ? JSON.parse(r.payload as string) : null,
            timestamp: Number(r.timestamp),
        }));
    }
}

/** Shape of the daemon's usage snapshot payload. */
interface UsageSnapshotPayload {
    snapshot_type: 'phase' | 'run';
    run_id: string;
    phase?: string;
    total_tokens_in: number;
    total_tokens_out: number;
    total_duration_ms: number;
    total_llm_calls: number;
    total_invocations: number;
    by_phase: Record<string, unknown>;
    by_agent: Record<string, unknown>;
    by_model: Record<string, {
        provider: string;
        model: string;
        tokens_in: number;
        tokens_out: number;
        llm_calls: number;
    }>;
}
