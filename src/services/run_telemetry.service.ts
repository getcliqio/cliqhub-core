/**
 * Fleet-wide OTEL telemetry rollup, sourced entirely from `run.execute`
 * root spans in `cliq.run_spans`.
 *
 * Each daemon stamps `run.usage.*` and `run.outcome` on the run root
 * span (see `daemon/src/core/service/run_executor.ts`). We aggregate
 * across that pre-rolled shape here — no join to `runs` or `phases`
 * needed, no per-agent scan. That keeps the query O(one root span per
 * run) and lets non-LLM fleets show meaningful activity metrics even
 * when cost is zero.
 *
 * Scoping model: caller passes the list of realm ids they can see
 * (resolved from `RealmService.list_for_user` at the controller
 * boundary). This service does NOT re-authorise; the controller must.
 */

import { QueryTypes } from 'sequelize';

import { get_sequelize } from '../lib/sequelize.js';
import { get_logger } from '../lib/log.js';
import type { TelemetrySummaryData } from '../schemas/telemetry/data.js';

const log = get_logger('run-telemetry');

/** Default window when the caller omits `window_days`. */
export const DEFAULT_WINDOW_DAYS = 7;
/** Cap to keep the fetched row set bounded even for admins. */
export const MAX_WINDOW_DAYS = 90;
/** How many teams to include in the "top teams" cut. */
const TOP_TEAMS_LIMIT = 5;

type RootSpanRow = {
    end_unix_nano: string;
    attributes: Record<string, unknown> | null;
    /**
     * Canonical Hub team label, resolved via JOIN. NULL when the run
     * row was purged or the team was deleted since the span was
     * recorded.
     */
    team_label: string | null;
};

export type SummaryOptions = {
    /** Realm ids the caller is allowed to see. If empty, the response is empty. */
    visible_realm_ids: string[];
    /** Days back from `now`. Clamped to [1, MAX_WINDOW_DAYS]. */
    window_days?: number;
    /** Injected clock for deterministic tests. Defaults to Date.now. */
    now_ms?: number;
};

/** @deprecated Use SummaryOptions. */
export type Summary_options = SummaryOptions;

/** @deprecated Use TelemetrySummaryData (Zod DTO). */
export type Telemetry_summary = TelemetrySummaryData;

export class RunTelemetryService {
    static async summary(opts: SummaryOptions): Promise<TelemetrySummaryData> {
        // Clamp lookback so admins cannot unbounded-scan the span table.
        const days = RunTelemetryService.clamp_window_days(opts.window_days);
        const to_ms = opts.now_ms ?? Date.now();
        const from_ms = to_ms - days * 24 * 60 * 60 * 1000;
        const window: TelemetrySummaryData['window'] = { from_ms, to_ms, days };

        // No visible realms → empty rollup (authz already filtered at the controller).
        if (opts.visible_realm_ids.length === 0) {
            return RunTelemetryService.empty(window);
        }

        const rows = await RunTelemetryService.fetch_root_spans(opts.visible_realm_ids, from_ms, to_ms);
        return RunTelemetryService.rollup(rows, window);
    }

    private static async fetch_root_spans(
        realm_ids: string[],
        from_ms: number,
        to_ms: number,
    ): Promise<RootSpanRow[]> {
        // BIGINT compare in ns avoids per-row division.
        const from_ns = BigInt(from_ms) * 1_000_000n;
        const to_ns = BigInt(to_ms) * 1_000_000n;
        const sq = get_sequelize();
        try {
            // LEFT JOIN into authoritative team tables so team_label is canonical @scope/team.
            const rows = await sq.query<RootSpanRow>(
                `
                SELECT
                    s."end_unix_nano"                                              AS "end_unix_nano",
                    s."attributes"                                                 AS "attributes",
                    CASE
                        WHEN t."slug" IS NOT NULL AND sc."slug" IS NOT NULL
                            THEN '@' || sc."slug" || '/' || t."slug"
                        ELSE NULL
                    END                                                            AS "team_label"
                  FROM cliq."run_spans"  s
                  LEFT JOIN cliq."team_runs" tr ON tr."run_id" = s."run_id"
                  LEFT JOIN cliq."teams"     t  ON t."id"      = tr."team_id"
                  LEFT JOIN cliq."scopes"    sc ON sc."id"     = t."scope_id"
                 WHERE s."name" = 'run.execute'
                   AND s."parent_span_id" IS NULL
                   AND s."realm_id" = ANY($1::text[])
                   AND s."end_unix_nano" >= $2::bigint
                   AND s."end_unix_nano" <  $3::bigint
                `,
                {
                    bind: [realm_ids, from_ns.toString(), to_ns.toString()],
                    type: QueryTypes.SELECT,
                },
            );
            return rows;
        } catch (err) {
            log.warn(`telemetry query failed: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * Walk every root span once, updating totals + per-day/team/kind
     * accumulators in-place.
     */
    private static rollup(rows: RootSpanRow[], window: TelemetrySummaryData['window']): TelemetrySummaryData {
        const totals: TelemetrySummaryData['totals'] = {
            runs: 0,
            agent_invocations: 0,
            failures: 0,
            duration_ms: 0,
            cost_usd: 0,
            tokens_in: 0,
            tokens_out: 0,
        };
        const by_day = new Map<string, TelemetrySummaryData['by_day'][number]>();
        const by_team = new Map<string, TelemetrySummaryData['by_team'][number]>();
        const by_kind = new Map<string, TelemetrySummaryData['by_agent_kind'][number]>();
        // Fixed-shape 24-hour bucket so the client can always draw a strip.
        const by_hour: TelemetrySummaryData['by_hour'] = Array.from({ length: 24 }, (_, h) => ({
            hour: h, runs: 0, invocations: 0,
        }));

        for (const row of rows) {
            const attrs = RunTelemetryService.coerce_attrs(row.attributes);
            totals.runs += 1;

            const inv = RunTelemetryService.num(attrs['run.usage.total_invocations']);
            const dur = RunTelemetryService.num(attrs['run.usage.total_duration_ms']);
            const cost = RunTelemetryService.num(attrs['run.usage.total_cost_usd']);
            const fails = RunTelemetryService.num(attrs['run.usage.total_failures']);
            const tin = RunTelemetryService.num(attrs['run.usage.tokens.units_in']);
            const tout = RunTelemetryService.num(attrs['run.usage.tokens.units_out']);

            totals.agent_invocations += inv;
            totals.duration_ms += dur;
            totals.cost_usd += cost;
            totals.failures += fails;
            totals.tokens_in += tin;
            totals.tokens_out += tout;

            const day_key = RunTelemetryService.day_key(row.end_unix_nano);
            const day_row = by_day.get(day_key) ?? {
                date: day_key, runs: 0, invocations: 0, duration_ms: 0, cost_usd: 0, failures: 0,
            };
            day_row.runs += 1;
            day_row.invocations += inv;
            day_row.duration_ms += dur;
            day_row.cost_usd += cost;
            day_row.failures += fails;
            by_day.set(day_key, day_row);

            const hour = RunTelemetryService.hour_of_day(row.end_unix_nano);
            by_hour[hour].runs += 1;
            by_hour[hour].invocations += inv;

            // Only surface teams resolved via JOIN — purged teams stay in totals only.
            if (row.team_label) {
                const team_row = by_team.get(row.team_label) ?? {
                    team_label: row.team_label,
                    runs: 0, invocations: 0, duration_ms: 0, cost_usd: 0, failures: 0,
                };
                team_row.runs += 1;
                team_row.invocations += inv;
                team_row.duration_ms += dur;
                team_row.cost_usd += cost;
                team_row.failures += fails;
                by_team.set(row.team_label, team_row);
            }

            for (const kind of RunTelemetryService.extract_kinds(attrs)) {
                const kind_row = by_kind.get(kind) ?? {
                    kind, invocations: 0, duration_ms: 0, cost_usd: 0, failures: 0,
                };
                kind_row.invocations += RunTelemetryService.num(attrs[`run.usage.${kind}.invocations`]);
                kind_row.duration_ms += RunTelemetryService.num(attrs[`run.usage.${kind}.duration_ms`]);
                kind_row.cost_usd += RunTelemetryService.num(attrs[`run.usage.${kind}.cost_usd`]);
                kind_row.failures += RunTelemetryService.num(attrs[`run.usage.${kind}.failures`]);
                by_kind.set(kind, kind_row);
            }
        }

        return {
            window,
            totals,
            by_day: [...by_day.values()].sort((a, b) => a.date.localeCompare(b.date)),
            by_hour,
            by_team: [...by_team.values()]
                .sort(RunTelemetryService.by_invocations_desc)
                .slice(0, TOP_TEAMS_LIMIT),
            by_agent_kind: [...by_kind.values()].sort(RunTelemetryService.by_invocations_desc),
        };
    }

    private static by_invocations_desc<T extends { invocations: number }>(a: T, b: T): number {
        return b.invocations - a.invocations;
    }

    /** Discover agent kinds from `run.usage.<kind>.<metric>` attribute keys. */
    private static extract_kinds(attrs: Record<string, unknown>): string[] {
        const kinds = new Set<string>();
        for (const key of Object.keys(attrs)) {
            if (!key.startsWith('run.usage.')) continue;
            const rest = key.slice('run.usage.'.length);
            if (rest.startsWith('total_')) continue;
            const dot = rest.indexOf('.');
            if (dot <= 0) continue;
            kinds.add(rest.slice(0, dot));
        }
        return [...kinds];
    }

    private static empty(window: TelemetrySummaryData['window']): TelemetrySummaryData {
        return {
            window,
            totals: {
                runs: 0, agent_invocations: 0, failures: 0, duration_ms: 0,
                cost_usd: 0, tokens_in: 0, tokens_out: 0,
            },
            by_day: [],
            by_hour: Array.from({ length: 24 }, (_, h) => ({
                hour: h, runs: 0, invocations: 0,
            })),
            by_team: [],
            by_agent_kind: [],
        };
    }

    private static clamp_window_days(v: number | undefined): number {
        const n = Number.isFinite(v) ? Math.floor(v as number) : DEFAULT_WINDOW_DAYS;
        if (n < 1) return 1;
        if (n > MAX_WINDOW_DAYS) return MAX_WINDOW_DAYS;
        return n;
    }

    private static coerce_attrs(raw: unknown): Record<string, unknown> {
        if (!raw) return {};
        if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed as Record<string, unknown>;
                }
            } catch { /* fall through */ }
        }
        return {};
    }

    private static num(v: unknown): number {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string') {
            const n = Number(v);
            if (Number.isFinite(n)) return n;
        }
        return 0;
    }

    /** UTC date bucket for a span's end time. */
    private static day_key(end_unix_nano: string): string {
        try {
            const ms = Number(BigInt(end_unix_nano) / 1_000_000n);
            return new Date(ms).toISOString().slice(0, 10);
        } catch {
            return '1970-01-01';
        }
    }

    /** UTC hour-of-day (0..23) for a span's end time. */
    private static hour_of_day(end_unix_nano: string): number {
        try {
            const ms = Number(BigInt(end_unix_nano) / 1_000_000n);
            return new Date(ms).getUTCHours();
        } catch {
            return 0;
        }
    }
}
