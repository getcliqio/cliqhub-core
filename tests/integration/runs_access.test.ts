/**
 * Core API 5 — runs and artifacts (S3–S8, S12, S15) over HTTP on live Postgres.
 *
 * Production app in its default mode (shadow), where the runs/ and artifacts/
 * routes are always enforced. Uses the Acme/Beta seed:
 * run_a1 lives in Acme realm A1, run_b1 in Beta realm B1, both in workspace_a1.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';

import { postgres_reachable } from '../migrated_platform/helpers/control_plane_store.js';
import { open_live_hub_app, close_live_hub_app } from '../migrated_platform/helpers/live_hub_app.js';
import { seed_authz, type Seed } from '../helpers/authz_seed.js';
import { Daemon, RealmMember, Run } from '../../src/models/index.js';

const has_postgres = await postgres_reachable();

describe.skipIf(!has_postgres)('runs and artifacts access (Core API 5)', () => {
    let app: Express;
    let s: Seed;
    const post = (path: string, token: string | null, body: Record<string, unknown> = {}) => {
        // Daemon push routes are dedup-wrapped and need a tx_id.
        const r = request(app).post(path).send({ tx_id: randomUUID(), ...body });
        return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    const run_ids = (res: request.Response) => ((res.body.data?.items ?? []) as Array<{ run_id: string }>).map((r) => r.run_id);

    beforeAll(async () => {
        
        const live = await open_live_hub_app();
        app = live.app;
        s = await seed_authz(app);
    }, 300_000);

    afterAll(async () => {
        await s?.cleanup();
        await close_live_hub_app();
    }, 300_000);

    describe('S3 / S4 — state pushes stay in the pusher’s realm', () => {
        it('another org’s user or daemon cannot complete or write to a run (404)', async () => {
            expect((await post('/v1/runs/complete', s.token.ben, { run_id: s.run_a1, state: 'failed' })).status).toBe(404);
            expect((await post('/v1/runs/complete', s.token.dB, { run_id: s.run_a1, state: 'failed' })).status).toBe(404);
            expect((await post('/v1/runs/append_logs', s.token.dB, { run_id: s.run_a1, chunk: 'x' })).status).toBe(404);
            expect((await post('/v1/runs/update_status', s.token.ben, { run_id: s.run_a1, phases: [] })).status).toBe(404);
            expect((await post('/v1/artifacts/submit', s.token.dB, { run_id: s.run_a1, phase: 'p', name: 'x', content: 'x' })).status).toBe(404);
            const run = await Run.findOne({ where: { run_id: s.run_a1 }, raw: true });
            expect(run?.state).toBe('running');
        });

        it('a realm viewer cannot push daemon state with a user token', async () => {
            expect((await post('/v1/runs/append_logs', s.token.mia, { run_id: s.run_a1, chunk: 'x' })).status).toBe(403);
        });

        it('the run’s own daemon can append logs', async () => {
            expect((await post('/v1/runs/append_logs', s.token.dA, { run_id: s.run_a1, chunk: 'hello\n' })).status).toBe(200);
        });

        it('runs/create: a daemon token files the run in its own realm, only for its own daemons', async () => {
            const ok = await post('/v1/runs/create', s.token.dA, {
                workspace_id: s.workspace_a1, team_id: 'authz-team', daemon_id: s.daemon_a1, run_id: randomUUID(),
            });
            expect(ok.status).toBe(200);
            const row = await Run.findOne({ where: { run_id: ok.body.data.run_id }, raw: true });
            expect(row?.realm_id).toBe(s.A1);
            await Run.destroy({ where: { run_id: ok.body.data.run_id } });

            // Daemon B's token naming daemon A → refused.
            expect((await post('/v1/runs/create', s.token.dB, {
                workspace_id: s.workspace_a1, team_id: 'authz-team', daemon_id: s.daemon_a1,
            })).status).toBe(403);
        });

        it('runs/create with a user token needs operate on a realm of that daemon', async () => {
            const body = { workspace_id: s.workspace_a1, team_id: 'authz-team', daemon_id: s.daemon_a1 };
            expect((await post('/v1/runs/create', s.token.mia, body)).status).toBe(403);
            expect((await post('/v1/runs/create', s.token.ben, body)).status).toBe(403);
        });
    });

    describe('S5 — list filters stay inside the caller’s realms', () => {
        it('a workspace filter no longer leaks another org’s runs', async () => {
            const mia = await post('/v1/runs/get', s.token.mia, { workspace_id: s.workspace_a1 });
            expect(mia.status).toBe(200);
            expect(run_ids(mia)).toContain(s.run_a1);
            expect(run_ids(mia)).not.toContain(s.run_b1);

            const ben = await post('/v1/runs/get', s.token.ben, { workspace_id: s.workspace_a1 });
            expect(run_ids(ben)).toContain(s.run_b1);
            expect(run_ids(ben)).not.toContain(s.run_a1);

            const nora = await post('/v1/runs/get', s.token.nora, { workspace_id: s.workspace_a1 });
            expect(run_ids(nora)).toEqual([]);
        });

        it('naming a realm you cannot see → 404', async () => {
            expect((await post('/v1/runs/get', s.token.mia, { realm_id: s.B1 })).status).toBe(404);
        });

        it('org owners see runs in every realm of their org without being added', async () => {
            const res = await post('/v1/runs/get', s.token.olivia, { org_id: s.acme, all: true });
            expect(res.status).toBe(200);
            expect(run_ids(res)).toContain(s.run_a1);
            expect(run_ids(res)).not.toContain(s.run_b1);
        });
    });

    describe('S6 / S7 / S12 — reads of one run', () => {
        it('another org gets 404 on get_by_id, get_status, get_telemetry and stream', async () => {
            expect((await post('/v1/runs/get_by_id', s.token.ben, { run_id: s.run_a1 })).status).toBe(404);
            expect((await post('/v1/runs/get_status', s.token.ben, { run_id: s.run_a1 })).status).toBe(404);
            expect((await post('/v1/runs/get_telemetry', s.token.ben, { run_id: s.run_a1, kind: 'usage' })).status).toBe(404);
            expect((await request(app).get('/v1/runs/stream').query({ run_id: s.run_a1 }).set('Authorization', `Bearer ${s.token.ben}`)).status).toBe(404);
        });

        it('a realm viewer and the org owner can read it', async () => {
            const mia = await post('/v1/runs/get_by_id', s.token.mia, { run_id: s.run_a1 });
            expect(mia.status).toBe(200);
            expect(mia.body.data.run_id).toBe(s.run_a1);
            expect((await post('/v1/runs/get_by_id', s.token.olivia, { run_id: s.run_a1 })).status).toBe(200);
        });

        it('a run that does not exist → 404 (was 200 with null)', async () => {
            expect((await post('/v1/runs/get_by_id', s.token.sam, { run_id: 'no-such-run' })).status).toBe(404);
        });
    });

    describe('S8 — artifacts', () => {
        it('another org cannot list, read or delete a run’s artifacts', async () => {
            expect((await post('/v1/artifacts/get', s.token.ben, { run_id: s.run_a1 })).status).toBe(404);
            expect((await post('/v1/artifacts/get_by_id', s.token.ben, { artifact_id: s.artifact_a1 })).status).toBe(404);
            expect((await post('/v1/artifacts/delete', s.token.ben, { artifact_id: s.artifact_a1 })).status).toBe(404);
        });

        it('a viewer can list but not delete', async () => {
            expect((await post('/v1/artifacts/get', s.token.mia, { run_id: s.run_a1 })).status).toBe(200);
            expect((await post('/v1/artifacts/delete', s.token.mia, { artifact_id: s.artifact_a1 })).status).toBe(403);
        });
    });

    describe('S15 — run control needs operate', () => {
        it('a viewer cannot cancel or supply inputs', async () => {
            expect((await post('/v1/runs/cancel', s.token.mia, { run_id: s.run_a1 })).status).toBe(403);
            expect((await post('/v1/runs/supply_inputs', s.token.mia, { run_id: s.run_a1, inputs: { a: 1 } })).status).toBe(403);
        });

        it('the org owner can cancel a run in a realm they were never added to', async () => {
            // A run on a daemon, so the old handler check (daemon membership) would have refused Olivia.
            const daemon_id = `azdc${s.stamp}`;
            await Daemon.create({ id: daemon_id, api_key_hash: 'x', created_at: Date.now(), last_registered_at: Date.now() } as never);
            await RealmMember.create({ id: randomUUID(), realm_id: s.A1, member_type: 'daemon', member_id: daemon_id, role: 'operator', created_at: Date.now() } as never);
            const run_id = `azcancel${s.stamp}`;
            await Run.create({ run_id, workspace_id: s.workspace_a1, team_id: 'authz-team', started_at: Date.now(), realm_id: s.A1, org_id: s.acme, daemon_id, state: 'running' } as never);
            try {
                const res = await post('/v1/runs/cancel', s.token.olivia, { run_id });
                expect(res.status).toBe(200);
                expect(res.body.data.cancelled).toBe(true);
            } finally {
                await Run.destroy({ where: { run_id } });
                await RealmMember.destroy({ where: { member_id: daemon_id } });
                await Daemon.destroy({ where: { id: daemon_id } });
            }
        });
    });
});
