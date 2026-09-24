/**
 * RunTelemetryService — aggregates `run.usage.*` attributes stamped
 * on `run.execute` root spans into a fleet-wide dashboard rollup.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock_query = vi.fn();
vi.mock('../../../src/lib/sequelize.js', () => ({
    get_sequelize: () => ({ query: mock_query }),
}));

vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({
        info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
    }),
}));

import {
    RunTelemetryService,
    DEFAULT_WINDOW_DAYS,
    MAX_WINDOW_DAYS,
} from '../../../src/services/run_telemetry.service.js';

const NOW_MS = 1_800_000_000_000; // fixed clock for stable day-key assertions

function ns(ms: number): string {
    return (BigInt(ms) * 1_000_000n).toString();
}

function root_row(
    end_ms: number,
    attributes: Record<string, unknown>,
    team_label: string | null = '@team/from-join',
) {
    // The service now resolves team_label via SQL JOIN, so tests
    // simulate that by attaching it to the row shape directly.
    return { end_unix_nano: ns(end_ms), attributes, team_label };
}

describe('RunTelemetryService.summary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns an empty summary when the caller has no visible realms (no query fired)', async () => {
        const out = await RunTelemetryService.summary({
            visible_realm_ids: [],
            now_ms: NOW_MS,
        });

        expect(mock_query).not.toHaveBeenCalled();
        expect(out.totals.runs).toBe(0);
        expect(out.by_day).toEqual([]);
        expect(out.by_team).toEqual([]);
        expect(out.by_agent_kind).toEqual([]);
        // by_hour is fixed-length 24 even when empty so the client can
        // draw a stable strip without conditional length handling.
        expect(out.by_hour).toHaveLength(24);
        expect(out.by_hour[0]).toEqual({ hour: 0, runs: 0, invocations: 0 });
        expect(out.by_hour[23]).toEqual({ hour: 23, runs: 0, invocations: 0 });
        expect(out.window.days).toBe(DEFAULT_WINDOW_DAYS);
        expect(out.window.to_ms).toBe(NOW_MS);
        expect(out.window.from_ms).toBe(NOW_MS - DEFAULT_WINDOW_DAYS * 86_400_000);
    });

    it('passes the visible realm ids and window bounds to the SQL query as bigint-nanoseconds', async () => {
        mock_query.mockResolvedValueOnce([]);
        await RunTelemetryService.summary({
            visible_realm_ids: ['r-alpha', 'r-beta'],
            window_days: 30,
            now_ms: NOW_MS,
        });

        expect(mock_query).toHaveBeenCalledTimes(1);
        const [, opts] = mock_query.mock.calls[0];
        expect(opts.bind[0]).toEqual(['r-alpha', 'r-beta']);
        // Nanosecond strings so postgres accepts them as ::bigint without
        // JS number-precision loss.
        expect(opts.bind[1]).toBe((BigInt(NOW_MS - 30 * 86_400_000) * 1_000_000n).toString());
        expect(opts.bind[2]).toBe((BigInt(NOW_MS) * 1_000_000n).toString());
    });

    it('clamps window_days to [1, MAX_WINDOW_DAYS]', async () => {
        mock_query.mockResolvedValue([]);

        const under = await RunTelemetryService.summary({
            visible_realm_ids: ['r'], window_days: 0, now_ms: NOW_MS,
        });
        expect(under.window.days).toBe(1);

        const over = await RunTelemetryService.summary({
            visible_realm_ids: ['r'], window_days: 9999, now_ms: NOW_MS,
        });
        expect(over.window.days).toBe(MAX_WINDOW_DAYS);
    });

    it('sums per-run totals across the window (mixed LLM + non-LLM fleet)', async () => {
        mock_query.mockResolvedValueOnce([
            root_row(NOW_MS - 1_000, {
                'run.usage.total_invocations': 3,
                'run.usage.total_duration_ms': 1_500,
                'run.usage.total_cost_usd': 0,       // non-LLM run
                'run.usage.total_failures': 0,
                'run.usage.shell.invocations': 2,
                'run.usage.shell.duration_ms': 1_000,
                'run.usage.shell.cost_usd': 0,
                'run.usage.shell.failures': 0,
                'run.usage.gate.invocations': 1,
                'run.usage.gate.duration_ms': 500,
                'run.usage.gate.cost_usd': 0,
                'run.usage.gate.failures': 0,
            }),
            root_row(NOW_MS - 2_000, {
                'run.usage.total_invocations': 4,
                'run.usage.total_duration_ms': 8_000,
                'run.usage.total_cost_usd': 0.42,     // LLM run
                'run.usage.total_failures': 1,
                'run.usage.tokens.units_in': 1_234,
                'run.usage.tokens.units_out': 5_678,
                'run.usage.llm.invocations': 3,
                'run.usage.llm.duration_ms': 6_500,
                'run.usage.llm.cost_usd': 0.42,
                'run.usage.llm.failures': 1,
                'run.usage.shell.invocations': 1,
                'run.usage.shell.duration_ms': 1_500,
                'run.usage.shell.cost_usd': 0,
                'run.usage.shell.failures': 0,
            }),
        ]);

        const out = await RunTelemetryService.summary({
            visible_realm_ids: ['r'], now_ms: NOW_MS,
        });

        expect(out.totals.runs).toBe(2);
        expect(out.totals.agent_invocations).toBe(7);
        expect(out.totals.duration_ms).toBe(9_500);
        expect(out.totals.cost_usd).toBeCloseTo(0.42);
        expect(out.totals.failures).toBe(1);
        expect(out.totals.tokens_in).toBe(1_234);
        expect(out.totals.tokens_out).toBe(5_678);

        // Non-LLM run still contributes activity totals — the whole point
        // of the "roll all" policy so non-LLM fleets aren't shown as
        // "$0 empty".
        const shell = out.by_agent_kind.find((k) => k.kind === 'shell');
        expect(shell).toEqual({
            kind: 'shell', invocations: 3, duration_ms: 2_500, cost_usd: 0, failures: 0,
        });
        const llm = out.by_agent_kind.find((k) => k.kind === 'llm');
        expect(llm).toEqual({
            kind: 'llm', invocations: 3, duration_ms: 6_500, cost_usd: 0.42, failures: 1,
        });
        // Kinds sorted by invocations desc (shell=3, llm=3, gate=1). Stable
        // ordering matters only for the top rows the UI shows.
        expect(out.by_agent_kind.map((k) => k.kind)).toEqual(
            expect.arrayContaining(['shell', 'llm', 'gate']),
        );
    });

    it('buckets by_day on the UTC day the run ended (spans-midnight case)', async () => {
        // Two runs: one ends on 2027-01-14 23:59:00Z, other on 2027-01-15
        // 00:00:30Z. Even though they were dispatched close in time, they
        // must land in different day buckets because we bucket by end time.
        const day1_end = Date.UTC(2027, 0, 14, 23, 59, 0);
        const day2_end = Date.UTC(2027, 0, 15, 0, 0, 30);
        mock_query.mockResolvedValueOnce([
            root_row(day1_end, { 'team.name': 't', 'run.usage.total_invocations': 1, 'run.usage.total_duration_ms': 100, 'run.usage.total_cost_usd': 0 }),
            root_row(day2_end, { 'team.name': 't', 'run.usage.total_invocations': 2, 'run.usage.total_duration_ms': 200, 'run.usage.total_cost_usd': 0.01 }),
        ]);

        const out = await RunTelemetryService.summary({
            visible_realm_ids: ['r'], window_days: 30, now_ms: day2_end + 60_000,
        });

        expect(out.by_day).toEqual([
            { date: '2027-01-14', runs: 1, invocations: 1, duration_ms: 100, cost_usd: 0, failures: 0 },
            { date: '2027-01-15', runs: 1, invocations: 2, duration_ms: 200, cost_usd: 0.01, failures: 0 },
        ]);
    });

    it('propagates run.usage.total_failures onto the per-day rollup', async () => {
        // Success-rate on the tile is computed client-side from
        // totals.failures / totals.agent_invocations; the per-day
        // failures column drives the "failure streaks" spot-check.
        mock_query.mockResolvedValueOnce([
            root_row(NOW_MS - 1_000, {
                'team.name': 't',
                'run.usage.total_invocations': 5,
                'run.usage.total_duration_ms': 500,
                'run.usage.total_cost_usd': 0,
                'run.usage.total_failures': 2,
            }),
        ]);

        const out = await RunTelemetryService.summary({
            visible_realm_ids: ['r'], now_ms: NOW_MS,
        });
        expect(out.by_day).toHaveLength(1);
        expect(out.by_day[0].failures).toBe(2);
    });

    it('buckets by_hour on the UTC hour the run ended', async () => {
        const three_am = Date.UTC(2027, 5, 15, 3, 30, 0);
        const seventeen = Date.UTC(2027, 5, 15, 17, 5, 0);
        mock_query.mockResolvedValueOnce([
            root_row(three_am, { 'team.name': 't', 'run.usage.total_invocations': 2 }),
            root_row(three_am + 60_000, { 'team.name': 't', 'run.usage.total_invocations': 1 }),
            root_row(seventeen, { 'team.name': 't', 'run.usage.total_invocations': 4 }),
        ]);

        const out = await RunTelemetryService.summary({
            visible_realm_ids: ['r'], window_days: 30, now_ms: seventeen + 3_600_000,
        });
        expect(out.by_hour[3]).toEqual({ hour: 3, runs: 2, invocations: 3 });
        expect(out.by_hour[17]).toEqual({ hour: 17, runs: 1, invocations: 4 });
        // Every other hour stays at zero — the client relies on the
        // fixed length so it can render without padding logic.
        expect(out.by_hour[0]).toEqual({ hour: 0, runs: 0, invocations: 0 });
        expect(out.by_hour).toHaveLength(24);
    });

    it('returns top teams by invocations, capped at 5', async () => {
        const rows = [];
        // 7 teams with descending invocations 70..10; only the top 5 must survive.
        for (let i = 0; i < 7; i += 1) {
            rows.push(root_row(NOW_MS - i * 1_000, {
                'run.usage.total_invocations': 70 - i * 10,
                'run.usage.total_duration_ms': 100,
                'run.usage.total_cost_usd': 0,
            }, `@scope/team-${i}`));
        }
        mock_query.mockResolvedValueOnce(rows);

        const out = await RunTelemetryService.summary({
            visible_realm_ids: ['r'], now_ms: NOW_MS,
        });

        expect(out.by_team).toHaveLength(5);
        expect(out.by_team[0].team_label).toBe('@scope/team-0');
        expect(out.by_team[0].invocations).toBe(70);
        expect(out.by_team.at(-1)?.team_label).toBe('@scope/team-4');
    });

    it('excludes runs with unresolved team_label from top teams (regression: no "(unknown)" noise)', async () => {
        // Two runs: one has a canonical label from the JOIN, the other
        // doesn't (team was purged, or run predates a team). Both must
        // contribute to totals + by_day, but only the resolved one may
        // appear in the by_team cut.
        mock_query.mockResolvedValueOnce([
            root_row(NOW_MS - 1_000, {
                'run.usage.total_invocations': 4,
                'run.usage.total_duration_ms': 400,
                'run.usage.total_cost_usd': 0,
            }, '@cliq/hello-world'),
            root_row(NOW_MS - 2_000, {
                'run.usage.total_invocations': 2,
                'run.usage.total_duration_ms': 200,
                'run.usage.total_cost_usd': 0,
            }, null),
        ]);

        const out = await RunTelemetryService.summary({
            visible_realm_ids: ['r'], now_ms: NOW_MS,
        });

        // Both runs count toward totals so the tile numbers stay honest.
        expect(out.totals.runs).toBe(2);
        expect(out.totals.agent_invocations).toBe(6);
        // But by_team only shows the run we could label authoritatively.
        expect(out.by_team).toHaveLength(1);
        expect(out.by_team[0].team_label).toBe('@cliq/hello-world');
    });

    it('propagates run.usage.total_failures onto the per-team rollup so hotspots are surfaceable', async () => {
        // Two runs of the same team; one had 2 failed agent calls,
        // the other had 1. The team-level row must sum them so the
        // "team X had N failures — investigate" insight has real
        // data to key off.
        mock_query.mockResolvedValueOnce([
            root_row(NOW_MS - 1_000, {
                'run.usage.total_invocations': 5,
                'run.usage.total_failures': 2,
            }, '@cliq/flaky-team'),
            root_row(NOW_MS - 2_000, {
                'run.usage.total_invocations': 3,
                'run.usage.total_failures': 1,
            }, '@cliq/flaky-team'),
        ]);

        const out = await RunTelemetryService.summary({
            visible_realm_ids: ['r'], now_ms: NOW_MS,
        });

        expect(out.by_team).toHaveLength(1);
        expect(out.by_team[0].failures).toBe(3);
        expect(out.by_team[0].runs).toBe(2);
    });

    it('returns an empty summary (not a throw) if the underlying query fails', async () => {
        mock_query.mockRejectedValueOnce(new Error('db down'));
        const out = await RunTelemetryService.summary({
            visible_realm_ids: ['r'], now_ms: NOW_MS,
        });
        expect(out.totals.runs).toBe(0);
        expect(out.by_day).toEqual([]);
    });

    it('handles missing or malformed attributes without throwing', async () => {
        mock_query.mockResolvedValueOnce([
            { end_unix_nano: ns(NOW_MS - 100), attributes: null },
            { end_unix_nano: ns(NOW_MS - 200), attributes: {} },
            { end_unix_nano: ns(NOW_MS - 300), attributes: { 'run.usage.total_invocations': 'not-a-number' } },
        ]);
        const out = await RunTelemetryService.summary({
            visible_realm_ids: ['r'], now_ms: NOW_MS,
        });
        // Still counts 3 runs, just no metric contribution from the bad rows.
        expect(out.totals.runs).toBe(3);
        expect(out.totals.agent_invocations).toBe(0);
        expect(out.totals.duration_ms).toBe(0);
    });
});
