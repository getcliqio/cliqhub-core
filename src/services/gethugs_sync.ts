/**
 * Marks for the getHugs reconcile (PLAN-gethugs-step2-provisioning.md, sub-step 2).
 *
 * Every write that changes what getHugs mirrors — an org, its members and roles, its people, realms, realm members,
 * channels — marks the org as needing a sync. A mark carries no data: the reconcile (sub-step 3) reads the whole org
 * and makes getHugs match, so a mark can't be wrong and marking twice is free. Inside a transaction the mark is
 * written after commit, so a rolled-back write marks nothing and the mark never holds a lock in the caller's
 * transaction. A mark that fails is logged, never thrown: the nightly pass marks every switched org anyway.
 *
 * Every org is marked, switched or not; only switched orgs are reconciled (sub-step 4).
 */

import { QueryTypes, type Transaction } from 'sequelize';

import { get_sequelize } from '../db/sequelize.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('gethugs_sync');

/** Ids that may be empty, null or repeated. */
type Ids = string | null | undefined | ReadonlyArray<string | null | undefined>;

function ids_of(ids: Ids): string[] {
    const list = Array.isArray(ids) ? ids : [ids];
    return [...new Set(list.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/** Runs `write` now, or after `t` commits; a failure is logged, not thrown. */
async function after_commit(t: Transaction | null | undefined, what: string, write: () => Promise<void>): Promise<void> {
    const run = async () => {
        try {
            await write();
        } catch (err) {
            log.warn('gethugs_mark_failed', { what, error: err instanceof Error ? err.message : String(err) });
        }
    };
    if (t) t.afterCommit(run);
    else await run();
}

/** Marks orgs as needing a getHugs sync. Unknown ids are ignored. */
export async function gethugs_mark(org_ids: Ids, t?: Transaction | null): Promise<void> {
    const ids = ids_of(org_ids);
    if (ids.length === 0) return;
    await after_commit(t, 'org', () => mark_now(ids));
}

/**
 * Marks the orgs a person is in (any membership row, pending or removed included: whether they still belong there is
 * the reconcile's question). The orgs are read now — inside `t`, so a membership made in it counts.
 */
export async function gethugs_mark_user(user_ids: Ids, t?: Transaction | null): Promise<void> {
    const ids = ids_of(user_ids);
    if (ids.length === 0) return;
    const orgs = await orgs_where('SELECT DISTINCT org_id FROM cliq.org_members WHERE user_id = ANY(ARRAY[:ids]::uuid[])', ids, t);
    await gethugs_mark(orgs, t);
}

/** Marks the orgs that hold these realms (read now, inside `t`, so a realm about to be deleted still counts). */
export async function gethugs_mark_realm(realm_ids: Ids, t?: Transaction | null): Promise<void> {
    const ids = ids_of(realm_ids);
    if (ids.length === 0) return;
    const orgs = await orgs_where('SELECT DISTINCT org_id FROM cliq.realms WHERE id = ANY(ARRAY[:ids]::text[])', ids, t);
    await gethugs_mark(orgs, t);
}

/**
 * Reads which orgs to mark. Inside `t` an error is not swallowed: Postgres has already aborted the caller's
 * transaction, and carrying on would only fail later with a less useful error.
 */
async function orgs_where(sql: string, ids: string[], t?: Transaction | null): Promise<string[]> {
    const read = async () =>
        (await get_sequelize().query<{ org_id: string }>(sql, { replacements: { ids }, type: QueryTypes.SELECT, transaction: t ?? undefined })).map((r) => r.org_id);
    if (t) return read();
    try {
        return await read();
    } catch (err) {
        log.warn('gethugs_mark_failed', { what: 'lookup', error: err instanceof Error ? err.message : String(err) });
        return [];
    }
}

async function mark_now(org_ids: string[]): Promise<void> {
    await get_sequelize().query(
        `INSERT INTO cliq.gethugs_sync (org_id, marked_at)
         SELECT id, clock_timestamp() FROM cliq.orgs WHERE id = ANY(ARRAY[:ids]::uuid[])
         ON CONFLICT (org_id) DO UPDATE SET marked_at = EXCLUDED.marked_at`,
        { replacements: { ids: org_ids } },
    );
}

/** The tables (run by `migrate_hub_schema`; safe to run again). */
export async function migrate_gethugs_sync(sequelize: ReturnType<typeof get_sequelize>): Promise<void> {
    // One row per org that was ever marked: when it was marked and synced, the backoff, what getHugs refused.
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS cliq.gethugs_sync (
            org_id UUID PRIMARY KEY REFERENCES cliq.orgs(id) ON DELETE CASCADE,
            marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            synced_at TIMESTAMPTZ,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_try_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_error TEXT,
            report JSONB NOT NULL DEFAULT '[]'::jsonb
        )
    `);
    // Step 8: no switching — every org is on getHugs. An org never marked yet (one from before the cut-over) is due now.
    await sequelize.query('ALTER TABLE cliq.gethugs_sync DROP COLUMN IF EXISTS state');
    await sequelize.query('INSERT INTO cliq.gethugs_sync (org_id) SELECT id FROM cliq.orgs ON CONFLICT (org_id) DO NOTHING');
    // getHugs' id for each mirrored record, per org: a cliq user in two orgs is two people in getHugs. The external
    // references (cliqhub:<kind>:<id>) stay the truth — a lost link is found again by reference.
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS cliq.gethugs_links (
            org_id UUID NOT NULL REFERENCES cliq.orgs(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CONSTRAINT gethugs_links_kind_check CHECK (kind IN ('org', 'user', 'realm', 'channel', 'destination')),
            cliq_id TEXT NOT NULL,
            gethugs_id TEXT NOT NULL,
            PRIMARY KEY (org_id, kind, cliq_id)
        )
    `);
    // The getHugs template version installed for a team hug's bundle, per org (PLAN-gethugs-step3-asking.md).
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS cliq.gethugs_templates (
            org_id UUID NOT NULL REFERENCES cliq.orgs(id) ON DELETE CASCADE,
            sha256 TEXT NOT NULL,
            name TEXT NOT NULL,
            template_id TEXT NOT NULL,
            version_id TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, sha256)
        )
    `);
    // Run files and getHugs documents (PLAN-gethugs-step5-files.md): `out` — a run artifact a Hug shows, uploaded once per
    // workspace; `in` — a file someone sent in an answer, stored once as a run artifact.
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS cliq.gethugs_documents (
            workspace_id TEXT NOT NULL,
            document_id TEXT NOT NULL UNIQUE,
            artifact_id TEXT NOT NULL,
            direction TEXT NOT NULL CONSTRAINT gethugs_documents_direction_check CHECK (direction IN ('out', 'in')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (workspace_id, artifact_id, direction)
        )
    `);
}
