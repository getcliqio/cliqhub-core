/**
 * PLAN-gethugs-step2-provisioning.md sub-step 4: the worker — one process at a time (the lock), marked orgs that are
 * switched or switching, backoff on failure, a switch that finishes switches the org on and one that fails doesn't,
 * the nightly pass, and switching off. Against a fake getHugs.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { close_test_control_plane_store, database_url, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { FakeGethugs } from '../helpers/fake_gethugs.js';
import { get_sequelize } from '../../src/db/sequelize.js';
import { Org, OrgMember, OrgRole, User } from '../../src/models/index.js';
import { seed_default_roles_for_org } from '../../src/models/migrations/migrate_org_roles.js';
import { GethugsPartner, hugs_provider_of } from '../../src/services/gethugs.service.js';
import { gethugs_mark } from '../../src/services/gethugs_sync.js';
import { backoff_s, GETHUGS_SYNC_LOCK_KEY, gethugs_switch_off, gethugs_switch_on, run_gethugs_sync } from '../../src/services/gethugs_worker.js';
import { RealmService } from '../../src/services/realm.service.js';

const has_postgres = await postgres_reachable();
const uid = () => `gw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

describe.skipIf(!has_postgres)('the getHugs worker', () => {
    const orgs: string[] = [];
    let fake: FakeGethugs;
    let partner: GethugsPartner;

    /** An active org with its owner and default realm (or without the realm: its reconcile fails). */
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
        const [rows] = await get_sequelize().query('SELECT state, synced_at, attempts, next_try_at, last_error, report FROM cliq.gethugs_sync WHERE org_id = :org_id', { replacements: { org_id } });
        return (rows as Array<{ state: string; synced_at: Date | null; attempts: number; next_try_at: Date; last_error: string | null; report: unknown[] }>)[0];
    }
    const mine = (ids: string[]) => ids.filter((id) => orgs.includes(id));

    beforeAll(async () => {
        process.env.CLIQ_BFF_LOG_LEVEL = 'error';
        await open_test_control_plane_store();
    });
    beforeEach(() => {
        fake = new FakeGethugs();
        partner = new GethugsPartner({ url: 'http://gethugs.test', token: 'hugs_svc_test' }, fake.fetch);
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

    it('nothing runs without getHugs configured', async () => {
        expect(await run_gethugs_sync(new Date(), null)).toEqual({ ran: false, nightly: 0, synced: [], failed: [], switched: [] });
    });

    it('a switch that finishes switches the org on, with the report; marks on orgs not switched are ignored', async () => {
        const a = await org();
        const b = await org();
        await gethugs_mark(b);
        await gethugs_switch_on(a);
        expect((await sync_row(a)).state).toBe('switching');

        const run = await run_gethugs_sync(new Date(), partner);
        expect(run.ran).toBe(true);
        expect(mine(run.synced)).toEqual([a]);
        expect(mine(run.switched)).toEqual([a]);
        expect(await hugs_provider_of(a)).toBe('gethugs');
        expect(await hugs_provider_of(b)).toBe('cliqhub');
        expect(fake.org_by_ref(`org:${a}`)).toBeDefined();
        expect(fake.org_by_ref(`org:${b}`)).toBeUndefined();
        const row = await sync_row(a);
        expect([row.state, row.attempts, row.last_error, row.report]).toEqual(['idle', 0, null, []]);

        // Synced and not marked since: not reconciled again. A new mark is.
        expect(mine((await run_gethugs_sync(new Date(), partner)).synced)).toEqual([]);
        await gethugs_mark(a);
        expect(mine((await run_gethugs_sync(new Date(), partner)).synced)).toEqual([a]);
    });

    it('a switch that fails leaves the org on cliqhub and backs off; once it can finish, it switches on', async () => {
        const a = await org({ realm: false });
        await gethugs_switch_on(a);
        const t0 = new Date();
        const run = await run_gethugs_sync(t0, partner);
        expect(mine(run.failed)).toEqual([a]);
        expect(await hugs_provider_of(a)).toBe('cliqhub');
        let row = await sync_row(a);
        expect([row.state, row.attempts, row.last_error]).toEqual(['switching', 1, expect.stringMatching(/no default realm/)]);
        expect(row.next_try_at.getTime()).toBe(t0.getTime() + 60_000);

        // Not due yet: left alone. Due: tried again, waiting twice as long.
        expect(mine((await run_gethugs_sync(new Date(t0.getTime() + 30_000), partner)).failed)).toEqual([]);
        const t1 = new Date(t0.getTime() + 61_000);
        await run_gethugs_sync(t1, partner);
        row = await sync_row(a);
        expect([row.attempts, row.next_try_at.getTime()]).toEqual([2, t1.getTime() + 120_000]);

        // The realm appears (a write that marks): due again, it finishes and switches on.
        const owner = String((await Org.findByPk(a, { attributes: ['owner_id'], raw: true }))!.owner_id);
        await RealmService.create(owner, 'default', 'Main', { org_id: a });
        const t2 = new Date(t1.getTime() + 121_000);
        expect(mine((await run_gethugs_sync(t2, partner)).switched)).toEqual([a]);
        expect(await hugs_provider_of(a)).toBe('gethugs');
        expect((await sync_row(a)).attempts).toBe(0);
    });

    it('one process at a time: while another holds the lock, nothing runs', async () => {
        const a = await org();
        await gethugs_switch_on(a);
        const other = new pg.Client({ connectionString: database_url });
        await other.connect();
        try {
            await other.query('SELECT pg_advisory_lock($1)', [GETHUGS_SYNC_LOCK_KEY]);
            expect((await run_gethugs_sync(new Date(), partner)).ran).toBe(false);
            expect(fake.calls).toEqual([]);
            await other.query('SELECT pg_advisory_unlock($1)', [GETHUGS_SYNC_LOCK_KEY]);
            expect(mine((await run_gethugs_sync(new Date(), partner)).switched)).toEqual([a]);
        } finally {
            await other.end();
        }
    });

    it('the nightly pass marks every switched org once a day, after 03:00 UTC', async () => {
        const a = await org();
        await gethugs_switch_on(a);
        await run_gethugs_sync(new Date(), partner);
        await get_sequelize().query(`DELETE FROM cliq.settings WHERE key = 'gethugs.nightly_on'`);

        const day = '2031-05-04';
        expect((await run_gethugs_sync(new Date(`${day}T02:59:00Z`), partner)).nightly).toBe(0);
        const night = await run_gethugs_sync(new Date(`${day}T03:01:00Z`), partner);
        expect(night.nightly).toBeGreaterThanOrEqual(1);
        // Every switched org, this one included, is marked and reconciled.
        expect(night.synced).toContain(a);
        expect((await run_gethugs_sync(new Date(`${day}T09:00:00Z`), partner)).nightly).toBe(0);
        await get_sequelize().query(`DELETE FROM cliq.settings WHERE key = 'gethugs.nightly_on'`);
    });

    it('switching off: back to cliqhub, and its marks are ignored again', async () => {
        const a = await org();
        await gethugs_switch_on(a);
        await run_gethugs_sync(new Date(), partner);
        await gethugs_switch_off(a);
        expect(await hugs_provider_of(a)).toBe('cliqhub');
        await gethugs_mark(a);
        expect(mine((await run_gethugs_sync(new Date(), partner)).synced)).toEqual([]);
    });
});
