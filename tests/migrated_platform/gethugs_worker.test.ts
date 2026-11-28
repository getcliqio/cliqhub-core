/**
 * PLAN-gethugs-step2-provisioning.md sub-step 4 (step 8: every org, no switch): the worker — one process at a time (the
 * lock), every marked org, backoff on failure, the nightly pass, `gethugs_sync_now`. Against a fake getHugs.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { close_test_control_plane_store, database_url, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { FakeGethugs } from '../helpers/fake_gethugs.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { Org, OrgMember, OrgRole, User } from '../../src/models/index.js';
import { seed_default_roles_for_org } from '../../src/models/migrations/migrate_org_roles.js';
import { GethugsPartner } from '../../src/services/gethugs.service.js';
import { gethugs_mark } from '../../src/services/gethugs_sync.js';
import { backoff_s, GETHUGS_SYNC_LOCK_KEY, gethugs_sync_now, run_gethugs_sync } from '../../src/services/gethugs_worker.js';
import { RealmService } from '../../src/services/realm.service.js';

const has_postgres = await postgres_reachable();
const uid = () => `gw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

describe.skipIf(!has_postgres)('the getHugs worker', () => {
    const orgs: string[] = [];
    let fake: FakeGethugs;
    let partner: GethugsPartner;

    /** An active org with its owner and default realm (or without the realm: it waits, unprovisioned). */
    async function org(opts: { realm?: boolean } = {}): Promise<string> {
        const owner = randomUUID();
        const name = uid();
        await User.create({ id: owner, username: name, email: `${name}@cliq.test`, display_name: name, status: 'active', role: 'user', password_hash: 'x' } as never);
        const row = await Org.create({ slug: uid(), display_name: 'Worker', status: 'active', owner_id: owner, activated_at: new Date() } as never);
        orgs.push(row.id);
        await seed_default_roles_for_org(row.id);
        const role = await OrgRole.findOne({ where: { org_id: row.id, slug: 'owner' }, attributes: ['id'], raw: true });
        await OrgMember.create({ org_id: row.id, user_id: owner, role: 'admin', role_id: role!.id, status: 'active', joined_at: new Date() } as never);
        if (opts.realm !== false) await RealmService.create(owner, 'default', 'Main', { org_id: row.id });
        return row.id;
    }
    async function sync_row(org_id: string) {
        const [rows] = await get_sequelize().query('SELECT synced_at, attempts, next_try_at, last_error, report FROM cliq.gethugs_sync WHERE org_id = :org_id', { replacements: { org_id } });
        return (rows as Array<{ synced_at: Date | null; attempts: number; next_try_at: Date; last_error: string | null; report: unknown[] }>)[0];
    }
    const mine = (ids: string[]) => ids.filter((id) => orgs.includes(id));
    /**
     * "Now" for a run, a second ahead: a mark is stamped by the database's clock, which can read a millisecond or two
     * past this process's `new Date()`, and a run at that instant would see the org as not due yet.
     */
    const soon = () => new Date(Date.now() + 1_000);
    /**
     * Orgs other tests left behind are due too (every org is on getHugs), and the day's nightly pass would mark them all:
     * settle them and record today's pass as done, so each run here reaches ours.
     */
    async function settle(): Promise<void> {
        await get_sequelize().query('UPDATE cliq.gethugs_sync SET synced_at = clock_timestamp(), attempts = 0, next_try_at = now()');
        await get_sequelize().query(
            `INSERT INTO cliq.settings (key, value, updated_at) VALUES ('gethugs.nightly_on', :today, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            { replacements: { today: new Date().toISOString().slice(0, 10) } },
        );
    }

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
        await settle();
    });
    beforeEach(() => {
        fake = new FakeGethugs();
        partner = new GethugsPartner({ url: 'http://gethugs.test', token: 'hugs_svc_test', app_url: 'http://app.gethugs.test' }, fake.fetch);
    });
    afterAll(async () => {
        if (orgs.length) {
            const ids = { replacements: { ids: orgs } };
            await get_sequelize().query('DELETE FROM cliq.realm_members WHERE realm_id IN (SELECT id FROM cliq.realms WHERE org_id = ANY(ARRAY[:ids]::uuid[]))', ids);
            await get_sequelize().query('DELETE FROM cliq.realms WHERE org_id = ANY(ARRAY[:ids]::uuid[])', ids);
            await Org.destroy({ where: { id: orgs } });
        }
        await close_test_control_plane_store();
    });

    it('backs off 1 min, doubling, at most 1 h', () => {
        expect([1, 2, 3, 6, 7, 20].map(backoff_s)).toEqual([60, 120, 240, 1920, 3600, 3600]);
    });

    it('every marked org is reconciled, with its report; synced and not marked since, it isn\'t again', async () => {
        const a = await org();
        const b = await org();
        const run = await run_gethugs_sync(soon(), partner);
        expect(run.ran).toBe(true);
        expect(mine(run.synced).sort()).toEqual([a, b].sort());
        expect(fake.org_by_ref(`org:${a}`)).toBeDefined();
        expect(fake.org_by_ref(`org:${b}`)).toBeDefined();
        const row = await sync_row(a);
        expect([row.attempts, row.last_error, row.report]).toEqual([0, null, []]);

        expect(mine((await run_gethugs_sync(soon(), partner)).synced)).toEqual([]);
        await gethugs_mark(a);
        expect(mine((await run_gethugs_sync(soon(), partner)).synced)).toEqual([a]);
    });

    it('a reconcile that fails backs off; once it can finish, it does', async () => {
        const a = await org();
        await gethugs_mark(a);
        fake.fail_with = 503;
        const t0 = soon();
        const run = await run_gethugs_sync(t0, partner);
        expect(mine(run.failed)).toEqual([a]);
        let row = await sync_row(a);
        expect([row.synced_at, row.attempts, row.last_error]).toEqual([null, 1, expect.any(String)]);
        expect(row.next_try_at.getTime()).toBe(t0.getTime() + 60_000);

        // Not due yet: left alone. Due: tried again, waiting twice as long.
        expect(mine((await run_gethugs_sync(new Date(t0.getTime() + 30_000), partner)).failed)).toEqual([]);
        const t1 = new Date(t0.getTime() + 61_000);
        await run_gethugs_sync(t1, partner);
        row = await sync_row(a);
        expect([row.attempts, row.next_try_at.getTime()]).toEqual([2, t1.getTime() + 120_000]);

        // getHugs is back: due again, it finishes.
        fake.fail_with = null;
        const t2 = new Date(t1.getTime() + 121_000);
        expect(mine((await run_gethugs_sync(t2, partner)).synced)).toEqual([a]);
        expect((await sync_row(a)).attempts).toBe(0);
    });

    it('gethugs_sync_now: due right away, past any backoff', async () => {
        const a = await org();
        await gethugs_mark(a);
        fake.fail_with = 503;
        const t0 = soon();
        await run_gethugs_sync(t0, partner);
        expect((await sync_row(a)).attempts).toBe(1);
        fake.fail_with = null;
        await gethugs_sync_now(a);
        expect(mine((await run_gethugs_sync(soon(), partner)).synced)).toEqual([a]);
    });

    it('an org with no realm yet is not a failure: synced with a no_realm_yet report; its first realm marks it again', async () => {
        const a = await org({ realm: false });
        await gethugs_mark(a);
        const run = await run_gethugs_sync(soon(), partner);
        expect(mine(run.failed)).toEqual([]);
        expect(mine(run.synced)).toEqual([a]);
        const row = await sync_row(a);
        expect([row.attempts, row.last_error, row.report]).toEqual([0, null, [expect.objectContaining({ kind: 'org', reason: 'no_realm_yet' })]]);
        expect(fake.org_by_ref(`org:${a}`)).toBeUndefined();

        const owner = String((await Org.findByPk(a, { attributes: ['owner_id'], raw: true }))!.owner_id);
        await RealmService.create(owner, 'default', 'Main', { org_id: a });
        expect(mine((await run_gethugs_sync(soon(), partner)).synced)).toEqual([a]);
        expect(fake.org_by_ref(`org:${a}`)).toBeDefined();
    });

    it('one process at a time: while another holds the lock, nothing runs', async () => {
        const a = await org();
        const other = new pg.Client({ connectionString: database_url });
        await other.connect();
        try {
            await other.query('SELECT pg_advisory_lock($1)', [GETHUGS_SYNC_LOCK_KEY]);
            expect((await run_gethugs_sync(soon(), partner)).ran).toBe(false);
            expect(fake.calls).toEqual([]);
            await other.query('SELECT pg_advisory_unlock($1)', [GETHUGS_SYNC_LOCK_KEY]);
            // Released, the run goes ahead and syncs ours (an org an earlier test marked again may come along too).
            expect(mine((await run_gethugs_sync(soon(), partner)).synced)).toContain(a);
        } finally {
            await other.end();
        }
    });

    it('the nightly pass marks every org once a day, after 03:00 UTC', async () => {
        const a = await org();
        await run_gethugs_sync(soon(), partner);
        await get_sequelize().query(`DELETE FROM cliq.settings WHERE key = 'gethugs.nightly_on'`);

        const day = '2031-05-04';
        expect((await run_gethugs_sync(new Date(`${day}T02:59:00Z`), partner)).nightly).toBe(0);
        const night = await run_gethugs_sync(new Date(`${day}T03:01:00Z`), partner);
        expect(night.nightly).toBeGreaterThanOrEqual(1);
        // Every org is marked; ours is reconciled (the batch reaches it, oldest mark first, over a few runs).
        const synced = new Set(night.synced);
        for (let i = 0; i < 50 && !synced.has(a); i++) (await run_gethugs_sync(new Date(`${day}T03:02:00Z`), partner)).synced.forEach((id) => synced.add(id));
        expect(synced.has(a)).toBe(true);
        expect((await run_gethugs_sync(new Date(`${day}T09:00:00Z`), partner)).nightly).toBe(0);
        await settle();
    });
});
