/**
 * Team hugs as getHugs templates (PLAN-gethugs-step8-cutover.md decision 10; PLAN-gethugs-step8-4-cliqd.md): the
 * templates part of the org reconcile. For each team installed in the org's realms, each of its hugs
 * (`hugs/<name>.hug` in an installed version) is the template **`@<scope>/<slug>/<hug>`**:
 *
 * - missing → `templates/create`; archived but wanted again → `templates/update { restore }`;
 * - every installed version's bundle is a version of it (`templates/add_version { make_current: false }`; identical
 *   files are the same version), recorded in `cliq.gethugs_templates` (`org_id, sha256 → template_id, version_id`)
 *   so a run asks with its exact version;
 * - its current version is the newest installed team version's (`templates/update { current_version_id }`);
 * - a template Core made (recorded) that no installed version carries any more, of a team with no open run in the
 *   org, is archived (`templates/delete`; its past Hugs stay readable). Templates Core didn't make are left alone.
 *
 * A refusal is reported (`kind: 'template'`), never blocking the rest.
 */

import { team_hugs } from '@getcliqio/cliq-sdk';
import { QueryTypes } from 'sequelize';

import { get_sequelize } from '../db/sequelize.js';
import { get_logger } from '../lib/log.js';
import { SemVer } from '../lib/semver.js';
import { TeamFileRepository } from '../repositories/team_file_repository.js';
import { RealmTeamListService } from './realm_team_list.service.js';
import { read_team_files } from './team_file_objects.js';
import { content_storage } from './version_content.js';

const log = get_logger('gethugs_templates');

/** What the reconcile lends this part: its writes (recorded), reads, and refusal reporting. */
export interface TemplatesContext {
    org_id: string;
    g_org: string;
    call: <T>(path: string, body: object, cliq_ref: string) => Promise<T>;
    read: <T>(path: string, body: object) => Promise<T>;
    attempt: <T>(kind: 'template', cliq_id: string, fn: () => Promise<T>) => Promise<T | null>;
}

interface HVersion { id: string; sha256: string }
interface HTemplate { id: string; name: string; builtin: boolean; current_version: HVersion | null; archived_at: number | null }

/** One installed version's bundle of a team hug. */
interface Carried { version: string; sha256: string; files: Record<string, string> }

/** A template's name for a team hug: the team as runs label it, then the hug. */
export function template_name(scope: string, slug: string, hug: string): string {
    return `@${scope}/${slug}/${hug}`;
}

const MANAGED = /^@([^/]+)\/([^/]+)\/[a-z][a-z0-9-]{0,63}$/;

async function rows<T extends object>(sql: string, replacements: Record<string, unknown>): Promise<T[]> {
    return get_sequelize().query<T>(sql, { replacements, type: QueryTypes.SELECT });
}

/**
 * The team hugs the org wants: template name → each installed version's bundle of it. Reads only the `.hug` files of
 * the installed versions.
 */
async function wanted_hugs(org_id: string): Promise<Map<string, Carried[]>> {
    const realm_ids = (await rows<{ id: string }>('SELECT id FROM cliq.realms WHERE org_id = :org_id AND deleted = false', { org_id })).map((r) => r.id);
    const seen = new Set<string>();
    const installed: Array<{ version_id: string; scope: string; slug: string; version: string }> = [];
    for (const entries of (await RealmTeamListService.entries_for(realm_ids)).values()) {
        for (const e of entries) {
            if (seen.has(e.version_id)) continue;
            seen.add(e.version_id);
            installed.push({ version_id: e.version_id, scope: e.scope ?? '', slug: e.slug, version: e.version });
        }
    }
    const out = new Map<string, Carried[]>();
    const storage = content_storage();
    if (!storage || installed.length === 0) return out;
    const repo = new TeamFileRepository();
    for (const iv of installed) {
        const hug_rows = (await repo.list_by_version(iv.version_id)).filter((f) => /^hugs\/[^/]+\.hug$/.test(f.path));
        if (hug_rows.length === 0) continue;
        // Published versions passed the hug checks; one that no longer reads is skipped here, not fatal.
        const { hugs } = team_hugs({ files: await read_team_files(storage, hug_rows) });
        for (const h of hugs) {
            const name = template_name(iv.scope, iv.slug, h.name);
            const list = out.get(name) ?? [];
            list.push({ version: iv.version, sha256: h.sha256, files: h.files });
            out.set(name, list);
        }
    }
    return out;
}

/** `@scope/slug` of the teams with an open run (running / awaiting input) in the org. */
async function teams_with_open_runs(org_id: string): Promise<Set<string>> {
    const open = await rows<{ scope: string; slug: string }>(
        `SELECT DISTINCT t."scope", t."name" AS "slug"
         FROM cliq."team_runs" r
         LEFT JOIN cliq."daemon_teams" dt ON dt."id" = r."team_id"
         JOIN cliq."teams" t ON t."id"::text = COALESCE(dt."team_id"::text, r."team_id")
         WHERE r."org_id" = :org_id AND r."state" IN ('running', 'awaiting_input')`,
        { org_id },
    );
    return new Set(open.map((o) => `@${o.scope}/${o.slug}`));
}

/** Records the getHugs template version Core installed for a team hug's bundle. */
async function record(org_id: string, sha256: string, name: string, template_id: string, version_id: string): Promise<void> {
    await get_sequelize().query(
        `INSERT INTO cliq.gethugs_templates (org_id, sha256, name, template_id, version_id) VALUES (:org_id, :sha256, :name, :template_id, :version_id)
         ON CONFLICT (org_id, sha256) DO UPDATE SET template_id = EXCLUDED.template_id, version_id = EXCLUDED.version_id, name = EXCLUDED.name`,
        { replacements: { org_id, sha256, name, template_id, version_id } },
    );
}

/** Makes the org's getHugs templates match its installed team hugs. */
export async function reconcile_templates(ctx: TemplatesContext): Promise<void> {
    const { org_id, g_org, call, read, attempt } = ctx;
    const wanted = await wanted_hugs(org_id);
    const recorded = await rows<{ sha256: string; template_id: string; version_id: string }>(
        'SELECT sha256, template_id, version_id FROM cliq.gethugs_templates WHERE org_id = :org_id', { org_id },
    );
    const mine = new Set(recorded.map((r) => r.template_id));
    const version_of = new Map(recorded.map((r) => [`${r.template_id}:${r.sha256}`, r.version_id]));
    const have = (await read<{ items: HTemplate[] }>('templates/get', { org_id: g_org, include_archived: true })).items.filter((t) => !t.builtin);
    // Prefer the template Core made when an archived one and a live one share a name.
    const by_name = new Map<string, HTemplate>();
    for (const t of have) {
        const other = by_name.get(t.name);
        if (!other || (other.archived_at && !t.archived_at) || (!mine.has(other.id) && mine.has(t.id))) by_name.set(t.name, t);
    }

    for (const [name, carried] of wanted) {
        const newest = carried.reduce((a, b) => (SemVer.compare(b.version, a.version) > 0 ? b : a));
        await attempt('template', name, async () => {
            let t = by_name.get(name) ?? null;
            if (!t) {
                t = await call<HTemplate>('templates/create', { org_id: g_org, name, files: newest.files }, `template:${name}`);
                if (t.current_version) {
                    await record(org_id, newest.sha256, name, t.id, t.current_version.id);
                    version_of.set(`${t.id}:${newest.sha256}`, t.current_version.id);
                }
            } else if (t.archived_at) {
                const current = t;
                t = await call<HTemplate>('templates/update', { org_id: g_org, id: current.id, restore: true }, `template:${name}`);
            }
            const template = t;
            for (const c of carried) {
                if (version_of.has(`${template.id}:${c.sha256}`)) continue;
                const added = await call<{ version: HVersion }>('templates/add_version', { org_id: g_org, id: template.id, files: c.files, make_current: false }, `template:${name}`);
                await record(org_id, c.sha256, name, template.id, added.version.id);
                version_of.set(`${template.id}:${c.sha256}`, added.version.id);
            }
            const current_id = version_of.get(`${template.id}:${newest.sha256}`);
            if (current_id && template.current_version?.id !== current_id) {
                await call('templates/update', { org_id: g_org, id: template.id, current_version_id: current_id }, `template:${name}`);
            }
        });
    }

    const open = await teams_with_open_runs(org_id);
    for (const t of have) {
        if (t.archived_at || !mine.has(t.id) || wanted.has(t.name)) continue;
        const m = MANAGED.exec(t.name);
        if (!m || open.has(`@${m[1]}/${m[2]}`)) continue;
        await attempt('template', t.name, () => call('templates/delete', { org_id: g_org, id: t.id }, `template:${t.name}`));
    }
    log.debug('gethugs_templates_reconciled', { org_id, wanted: wanted.size });
}
