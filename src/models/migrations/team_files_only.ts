/**
 * Every startup until it has run (PLAN-team-bundle S1.5): a published version's files become its only copy.
 *
 * While the old content columns exist (the schema migrations have made them nullable: nothing writes them):
 *   1. the backfill gives every published version without files its files (from its zip, else its columns);
 *   2. a check compares each published version's columns with its files: `manifest_yaml` = team.yml,
 *      `readme` = README.md, `dependencies_yaml` = dependencies.yml, each role in `roles_json` = roles/<name>.md,
 *      and each agent `agents_json` defines (an entry, env…) is defined the same way in team.yml. The other
 *      columns (`workflow_json`, `capability_json`, `tools`, `cliq_version`) are derived from team.yml, so they
 *      hold nothing the files don't;
 *   3. **only when every published version has files and nothing differs**, the content columns,
 *      `teams.draft_manifest` / `draft_description` / `draft_saved_at` and `cliq.drafts` (old unpublished builder
 *      drafts, dropped by decision, 2 Nov) are dropped, in one transaction, and the pass is recorded. Otherwise
 *      nothing is dropped: the problems are logged and stored under {@link TEAM_FILES_ONLY_REPORT_KEY} (readable with
 *      SQL), and the next start tries again.
 */
import { QueryTypes } from 'sequelize';
import { in_parallel } from '../../lib/in_parallel.js';
import { get_logger } from '../../lib/log.js';
import { get_sequelize } from '../../lib/sequelize.js';
import type { SettingsRepository } from '../../repositories/settings_repository.js';
import type { TeamFileRepository } from '../../repositories/team_file_repository.js';
import type { TeamVersionRepository } from '../../repositories/team_version_repository.js';
import { version_content, type VersionContent } from '../../services/version_content.js';
import type { PackageStorage } from '../../storage/package_storage.js';
import { backfill_team_files } from './backfill_team_files.js';

const log = get_logger('db.migrate');

/** `cliq.settings` key recording that the columns were dropped. */
export const TEAM_FILES_ONLY_KEY = 'migrate.team_files_only_2026_11';
/** `cliq.settings` key holding the last check's problems when it found any. */
export const TEAM_FILES_ONLY_REPORT_KEY = 'migrate.team_files_only_report';

/** The team_versions columns that go. */
export const CONTENT_COLUMNS = [
    'workflow_json', 'manifest_yaml', 'readme', 'capability_json', 'agents_json', 'roles_json',
    'dependencies_yaml', 'cliq_version', 'tools',
] as const;

/** A published version's content columns, as the check reads them. */
export interface VersionColumns {
    id: string;
    team_id: string;
    version: string | null;
    manifest_yaml: string | null;
    readme: string | null;
    dependencies_yaml: string | null;
    roles_json: string | null;
    agents_json: string | null;
}

/** What a pass did. */
export interface TeamFilesOnlyResult {
    /** True when the columns were dropped by this pass. */
    dropped: boolean;
    /** True when an earlier pass had dropped them. */
    already: boolean;
    /** `<team_id>@<version>: <what>` that stopped the drop. */
    problems: string[];
}

function json_of(text: string | null | undefined): unknown {
    try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/** The same JSON value (key order ignored). */
function same(a: unknown, b: unknown): boolean {
    const norm = (v: unknown): unknown => (Array.isArray(v) ? v.map(norm)
        : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]))
            : v);
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * What a version's columns hold that its files don't. Empty columns hold nothing.
 *
 * @param v - The version's content columns.
 * @param content - What its files say, or null when it has none.
 */
export function column_differences(v: VersionColumns, content: VersionContent | null): string[] {
    if (!content) return ['no files'];
    const out: string[] = [];
    if (v.manifest_yaml?.trim() && v.manifest_yaml !== content.manifest_yaml) out.push('team.yml differs from manifest_yaml');
    if (v.readme?.trim() && v.readme !== content.readme) out.push('README.md differs from readme');
    if (v.dependencies_yaml?.trim() && v.dependencies_yaml !== content.dependencies_yml) out.push('dependencies.yml differs from dependencies_yaml');
    const roles = json_of(v.roles_json);
    for (const r of Array.isArray(roles) ? roles as Array<{ name?: unknown; content_md?: unknown }> : []) {
        const name = typeof r?.name === 'string' ? r.name.replace(/\.md$/, '') : '';
        if (!name || typeof r.content_md !== 'string' || !r.content_md.trim()) continue;
        const file = content.roles.find((f) => f.name === name);
        if (!file) out.push(`roles/${name}.md missing`);
        else if (file.content_md !== r.content_md) out.push(`roles/${name}.md differs`);
    }
    const agents = json_of(v.agents_json);
    for (const [name, def] of Object.entries(agents && typeof agents === 'object' && !Array.isArray(agents) ? agents as Record<string, unknown> : {})) {
        if (!def || typeof def !== 'object' || !Object.keys(def).length) continue;
        if (!same(def, content.agents[name])) out.push(`agent ${name} defined differently`);
    }
    return out;
}

/** Whether a column still exists. */
async function column_exists(table: string, column: string): Promise<boolean> {
    const rows = await get_sequelize().query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'cliq' AND table_name = :table AND column_name = :column`,
        { type: QueryTypes.SELECT, replacements: { table, column } },
    );
    return rows.length > 0;
}

/**
 * After the drop: a content column an old schema migration added back (until 2 Nov the hub migrations re-added
 * `manifest_yaml` with default '' at every start) is dropped again when it holds nothing.
 */
async function drop_readded_columns(): Promise<void> {
    const sq = get_sequelize();
    for (const c of CONTENT_COLUMNS) {
        if (!(await column_exists('team_versions', c))) continue;
        const [{ n }] = await sq.query<{ n: string }>(
            `SELECT count(*) AS n FROM cliq.team_versions WHERE "${c}" IS NOT NULL AND "${c}"::text NOT IN ('', '[]', '{}')`,
            { type: QueryTypes.SELECT },
        );
        if (Number(n) > 0) {
            log.error('team_files_only_column_back', { column: c, rows: Number(n), note: 'kept: it holds data' });
            continue;
        }
        await sq.query(`ALTER TABLE cliq."team_versions" DROP COLUMN IF EXISTS "${c}"`);
        log.info('team_files_only_column_dropped_again', { column: c });
    }
}

/**
 * Make the files every published version's only copy, or report why not.
 *
 * @param deps - Storage, versions, files and settings.
 */
export async function team_files_only(deps: {
    storage: PackageStorage;
    versions: TeamVersionRepository;
    files: TeamFileRepository;
    settings: SettingsRepository;
}): Promise<TeamFilesOnlyResult> {
    const sq = get_sequelize();
    if (await deps.settings.find_by_key(TEAM_FILES_ONLY_KEY)) {
        await drop_readded_columns();
        return { dropped: false, already: true, problems: [] };
    }
    if (!(await column_exists('team_versions', 'manifest_yaml'))) return { dropped: false, already: true, problems: [] };

    // 1. Every published version gets its files.
    const backfill = await backfill_team_files(deps);

    // 2. Each published version's columns against its files.
    const rows = await sq.query<VersionColumns>(
        `SELECT id, team_id, version, manifest_yaml, readme, dependencies_yaml, roles_json, agents_json
         FROM cliq.team_versions WHERE status = 'published'`,
        { type: QueryTypes.SELECT },
    );
    const problems: string[] = [
        ...backfill.empty.map((v) => `${v}: no zip and no manifest`),
        ...backfill.failed,
    ];
    await in_parallel(rows, 8, async (v) => {
        let content: VersionContent | null;
        try {
            content = await version_content(v.id);
        } catch (err) {
            problems.push(`${v.team_id}@${v.version}: files unreadable (${err instanceof Error ? err.message : String(err)})`);
            return;
        }
        for (const d of column_differences(v, content)) problems.push(`${v.team_id}@${v.version}: ${d}`);
    });
    problems.sort();

    const report = JSON.stringify({ at: new Date().toISOString(), versions: rows.length, problems });
    if (problems.length) {
        log.error('team_files_only_not_dropped', { versions: rows.length, problems: problems.slice(0, 50), total: problems.length });
        if (await deps.settings.find_by_key(TEAM_FILES_ONLY_REPORT_KEY)) await deps.settings.update_by_key(TEAM_FILES_ONLY_REPORT_KEY, report);
        else await deps.settings.create(TEAM_FILES_ONLY_REPORT_KEY, report);
        return { dropped: false, already: false, problems };
    }

    // 3. Nothing differs: the second copy goes.
    await sq.transaction(async (t) => {
        await sq.query(`ALTER TABLE cliq."team_versions" ${CONTENT_COLUMNS.map((c) => `DROP COLUMN IF EXISTS "${c}"`).join(', ')}`, { transaction: t });
        await sq.query(`ALTER TABLE cliq."teams" DROP COLUMN IF EXISTS "draft_manifest", DROP COLUMN IF EXISTS "draft_description", DROP COLUMN IF EXISTS "draft_saved_at"`, { transaction: t });
        await sq.query(`DROP TABLE IF EXISTS cliq."drafts"`, { transaction: t });
    });
    await deps.settings.create(TEAM_FILES_ONLY_KEY, report);
    log.info('team_files_only_dropped', { versions: rows.length });
    return { dropped: true, already: false, problems: [] };
}
