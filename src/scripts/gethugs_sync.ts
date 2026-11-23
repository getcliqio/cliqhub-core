/**
 * Reconciles one org into getHugs now and prints what getHugs refused (PLAN-gethugs-step2-provisioning.md; step 8 —
 * every org is on getHugs, the worker keeps them all in sync; this is for seeing where one org stands).
 *
 *   npm run gethugs:sync -- <org_id>
 *
 * The script runs the sync itself (or waits while a running Core holds the worker's lock). When the reconcile fails the
 * worker keeps trying with backoff. Reads DATABASE_URL and GETHUGS_* from the environment (`npm run` passes `.env`);
 * prints no secrets.
 */

import { QueryTypes } from 'sequelize';

import { load_env } from '../config/env.js';
import { close_control_plane_store, init_control_plane_store } from '../db/control_plane_store.js';
import { get_sequelize } from '../db/sequelize.js';
import { gethugs_partner } from '../services/gethugs.service.js';
import type { Refusal } from '../services/gethugs_reconcile.js';
import { gethugs_sync_now, run_gethugs_sync } from '../services/gethugs_worker.js';

const WAIT_MS = 5 * 60_000;
const POLL_MS = 3_000;

interface Row { slug: string; display_name: string; synced_at: Date | null; attempts: number | null; last_error: string | null; report: Refusal[] | null; gethugs_id: string | null }

async function state_of(org_id: string): Promise<Row | null> {
    const [row] = await get_sequelize().query<Row>(
        `SELECT o.slug, o.display_name, s.synced_at, s.attempts, s.last_error, s.report,
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
    const org_id = process.argv.slice(2).find((a) => !a.startsWith('--'));
    if (!org_id) {
        console.error('Usage: npm run gethugs:sync -- <org_id>');
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
        const partner = gethugs_partner();
        const started = Date.now();
        await gethugs_sync_now(org_id);
        console.log(`${name}: reconciling into getHugs…`);
        while (Date.now() - started < WAIT_MS) {
            const run = await run_gethugs_sync(new Date(), partner);
            const now = await state_of(org_id);
            if (now?.synced_at && now.synced_at.getTime() >= started - 1000) {
                console.log(`${name}: in sync${now.gethugs_id ? ` (getHugs org ${now.gethugs_id})` : ''}.`);
                print_report(now.report ?? []);
                return 0;
            }
            if (now?.last_error && (now.attempts ?? 0) > 0) {
                console.error(`${name}: the reconcile failed: ${now.last_error}`);
                console.error('The worker tries again with backoff.');
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
