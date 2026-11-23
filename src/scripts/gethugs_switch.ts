/**
 * Switches one org's Hugs to getHugs, or back (PLAN-gethugs-step2-provisioning.md, sub-step 4) — until there is an
 * admin control for it.
 *
 *   npm run gethugs:switch -- <org_id>        reconcile the org into getHugs; switch it on when that finishes
 *   npm run gethugs:switch -- <org_id> --off  back to cliqhub's own Hugs (Hugs already in getHugs stay there)
 *
 * The script runs the sync itself (or waits while a running Core holds the worker's lock), then prints what getHugs
 * refused. When the reconcile fails the org stays switching: the worker keeps trying with backoff; `--off` cancels.
 * Reads DATABASE_URL and GETHUGS_* from the environment (`npm run` passes `.env`); prints no secrets.
 */

import { QueryTypes } from 'sequelize';

import { load_env } from '../config/env.js';
import { close_control_plane_store, init_control_plane_store } from '../db/control_plane_store.js';
import { get_sequelize } from '../db/sequelize.js';
import { gethugs_partner } from '../services/gethugs.service.js';
import type { Refusal } from '../services/gethugs_reconcile.js';
import { gethugs_switch_off, gethugs_switch_on, run_gethugs_sync } from '../services/gethugs_worker.js';

const WAIT_MS = 5 * 60_000;
const POLL_MS = 3_000;

interface Row { hugs_provider: string; slug: string; display_name: string; state: string | null; synced_at: Date | null; attempts: number | null; last_error: string | null; report: Refusal[] | null; gethugs_id: string | null }

async function state_of(org_id: string): Promise<Row | null> {
    const [row] = await get_sequelize().query<Row>(
        `SELECT o.hugs_provider, o.slug, o.display_name, s.state, s.synced_at, s.attempts, s.last_error, s.report,
                (SELECT gethugs_id FROM cliq.gethugs_links l WHERE l.org_id = o.id AND l.kind = 'org') AS gethugs_id
         FROM cliq.orgs o LEFT JOIN cliq.gethugs_sync s ON s.org_id = o.id WHERE o.id = :org_id`,
        { replacements: { org_id }, type: QueryTypes.SELECT },
    );
    return row ?? null;
}

function print_report(report: Refusal[]): void {
    if (!report.length) {
        console.log('getHugs refused nothing.');
        return;
    }
    console.log(`getHugs refused ${report.length} record(s) (skipped; the rest is in getHugs):`);
    for (const r of report) console.log(`  ${r.kind} ${r.cliq_id}: ${r.reason}${r.message ? ` — ${r.message}` : ''}`);
}

async function main(): Promise<number> {
    const args = process.argv.slice(2);
    const off = args.includes('--off');
    const org_id = args.find((a) => !a.startsWith('--'));
    if (!org_id) {
        console.error('Usage: npm run gethugs:switch -- <org_id> [--off]');
        return 2;
    }
    const config = load_env();
    await init_control_plane_store(config.database_url);
    try {
        const before = await state_of(org_id);
        if (!before) {
            console.error(`No org ${org_id}.`);
            return 1;
        }
        const name = `${before.display_name} (${before.slug})`;
        if (off) {
            await gethugs_switch_off(org_id);
            console.log(`${name}: Hugs are cliqhub's own again (from ${before.hugs_provider}). Hugs already in getHugs stay there.`);
            return 0;
        }
        const partner = gethugs_partner();
        if (!partner) {
            console.error('getHugs is not configured: set GETHUGS_URL and GETHUGS_PARTNER_TOKEN.');
            return 1;
        }
        const started = Date.now();
        await gethugs_switch_on(org_id);
        console.log(`${name}: ${before.hugs_provider === 'gethugs' ? 'already on getHugs — reconciling again' : 'switching to getHugs'}…`);
        while (Date.now() - started < WAIT_MS) {
            const run = await run_gethugs_sync(new Date(), partner);
            const now = await state_of(org_id);
            const synced = now?.synced_at && now.synced_at.getTime() >= started - 1000;
            if (now?.hugs_provider === 'gethugs' && now.state === 'idle' && synced) {
                console.log(`${name}: on getHugs${now.gethugs_id ? ` (getHugs org ${now.gethugs_id})` : ''}.`);
                print_report(now.report ?? []);
                return 0;
            }
            if (now?.last_error && (now.attempts ?? 0) > 0) {
                console.error(`${name}: the reconcile failed: ${now.last_error}`);
                console.error('It stays switching; the worker tries again with backoff. Cancel with --off.');
                return 1;
            }
            if (!run.ran) console.log('Another Core process is syncing; waiting…');
            await new Promise((r) => setTimeout(r, POLL_MS));
        }
        console.error(`${name}: not finished after ${WAIT_MS / 60_000} min; the worker carries on. Run again to see where it is.`);
        return 1;
    } finally {
        await close_control_plane_store();
    }
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    },
);
