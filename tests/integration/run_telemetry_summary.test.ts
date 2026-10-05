/**
 * runs/get_telemetry summary on live Postgres: root `run.execute` spans of a
 * visible realm roll up into totals, labelled by the daemon-installed team
 * (`cliq.daemon_teams` + its scope) the run used.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { DaemonTeam, Run, Scope } from '../../src/models/index.js';
import { get_sequelize } from '../../src/lib/sequelize.js';
import { RunTelemetryService } from '../../src/services/run_telemetry.service.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('run telemetry summary', () => {
    let s: Seed;
    let daemon_team_id: string;
    let team_slug: string;
    let scope_slug: string;
    const span_id = randomUUID();

    beforeAll(async () => {
        const live = await open_live_hub_app();
        s = await seed_authz(live.app);
        const scope = await Scope.findOne({ where: { org_id: s.acme }, attributes: ['id', 'slug'], raw: true }) as unknown as { id: string; slug: string };
        scope_slug = scope.slug;
        team_slug = `telem${s.stamp}`;
        daemon_team_id = randomUUID();
        const now = Date.now();
        await DaemonTeam.create({ id: daemon_team_id, daemon_id: s.daemon_a1, scope_id: scope.id, slug: team_slug, manifest: '{}', created_at: now, updated_at: now } as never);
        await Run.update({ team_id: daemon_team_id } as never, { where: { run_id: s.run_a1 } });
        const end_ns = BigInt(now) * 1_000_000n;
        await get_sequelize().query(
            `INSERT INTO cliq.run_spans (span_id, trace_id, parent_span_id, run_id, name, kind, start_unix_nano, end_unix_nano, attributes, realm_id, created_at)
             VALUES ($1, $2, NULL, $3, 'run.execute', 'INTERNAL', $4, $5, '{}'::jsonb, $6, $7)`,
            { bind: [span_id, randomUUID(), s.run_a1, (end_ns - 5_000_000_000n).toString(), end_ns.toString(), s.A1, now] },
        );
    }, 300_000);

    afterAll(async () => {
        await get_sequelize().query('DELETE FROM cliq.run_spans WHERE span_id = $1', { bind: [span_id] }).catch(() => {});
        await Run.update({ team_id: null } as never, { where: { run_id: s.run_a1 } }).catch(() => {});
        await DaemonTeam.destroy({ where: { id: daemon_team_id } }).catch(() => {});
        await s?.cleanup();
        await close_live_hub_app();
    });

    it('counts the realm\'s root spans and labels them @scope/team', async () => {
        const out = await RunTelemetryService.summary({ visible_realm_ids: [s.A1], window_days: 1 });
        expect(out.totals.runs).toBe(1);
        expect(out.by_team.map((t) => t.team_label)).toEqual([`@${scope_slug}/${team_slug}`]);
    });

    it('sees nothing for a realm the span is not in', async () => {
        const out = await RunTelemetryService.summary({ visible_realm_ids: [s.B1], window_days: 1 });
        expect(out.totals.runs).toBe(0);
    });
});
