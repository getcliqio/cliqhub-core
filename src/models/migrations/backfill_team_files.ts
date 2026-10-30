/**
 * Every startup (PLAN-team-bundle S1.4a): each published version without `team_files` rows gets them, so every
 * version is read from its files (S1.4b). Versions made before S1.3b and built-in versions seeded from the sdk
 * have none.
 *
 * - With a zip (on its id key since S1.2): the zip's team files, as they are. Paths that aren't part of a team
 *   (anything but team.yml, README.md, dependencies.yml and roles/<name>.md) are left out and logged.
 * - Without one: the version's columns: team.yml from `manifest_yaml`, README.md, dependencies.yml and each role
 *   in `roles_json` as roles/<name>.md. A version stored before team.yml was kept (no `manifest_yaml`, e.g. the
 *   built-in `@cliq/hello-world` 2.0.0) gets a team.yml rebuilt from what publish derived from it: its phases
 *   (`workflow_json`), inputs / use_when / not_for (`capability_json`) and agents (`agents_json`).
 *
 * A version that gets nothing (no zip and no manifest) is listed and left alone. Once a version has rows it is
 * never visited again, so a pass after the first finds nothing to do. A failure on one version doesn't stop the
 * others.
 */
import { is_bundle_path, TEAM_YML, unpack_bundle } from '@getcliqio/cliq-sdk';
import yaml from 'js-yaml';
import { get_logger } from '../../lib/log.js';
import { get_sequelize } from '../../lib/sequelize.js';
import type { TeamFileRepository } from '../../repositories/team_file_repository.js';
import type { TeamVersionRepository } from '../../repositories/team_version_repository.js';
import { team_file_content_type, write_team_file_objects } from '../../services/team_file_objects.js';
import { stored_key, type PackageStorage } from '../../storage/package_storage.js';

const log = get_logger('db.migrate');

type Version = Awaited<ReturnType<TeamVersionRepository['list_published_without_files']>>[number];

/** What a pass did. */
export interface TeamFilesBackfillResult {
    /** `<team_id>@<version>` given files from their zip. */
    from_zip: string[];
    /** `<team_id>@<version>` given files from their columns (no zip). */
    from_columns: string[];
    /** `<team_id>@<version>` with neither a zip nor a manifest: left without files. */
    empty: string[];
    /** `<team_id>@<version>: <why>` that failed (the next start tries again). */
    failed: string[];
}

/** Parse a JSON column, or null. */
function json_of(text: string | null | undefined): Record<string, unknown> | null {
    try {
        const v = text ? JSON.parse(text) : null;
        return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/**
 * team.yml for a version stored without one: rebuilt from the phases, inputs and agents publish derived from it.
 * Null when there are no phases to rebuild from.
 */
export function team_yml_from_derived(v: Pick<Version, 'version' | 'workflow_json' | 'capability_json' | 'agents_json' | 'team_scope' | 'team_name' | 'team_description'>): string | null {
    const workflow = json_of(v.workflow_json);
    const phases = Array.isArray(workflow?.phases) ? workflow.phases : [];
    if (!phases.length) return null;
    const capability = json_of(v.capability_json) ?? {};
    const agents = json_of(v.agents_json);
    const doc: Record<string, unknown> = { name: v.team_scope ? `@${v.team_scope}/${v.team_name}` : v.team_name, version: v.version };
    if (v.team_description) doc.description = v.team_description;
    for (const key of ['inputs', 'use_when', 'not_for'] as const) {
        if (Array.isArray(capability[key]) && (capability[key] as unknown[]).length) doc[key] = capability[key];
    }
    if (agents && Object.keys(agents).length) doc.agents = agents;
    doc.phases = phases;
    if (Array.isArray(workflow?.support) && workflow.support.length) doc.support = workflow.support;
    return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}

/** A version's files from its columns: team.yml (stored, or rebuilt), README.md, dependencies.yml and its roles. */
export function files_from_columns(v: Pick<Version, 'manifest_yaml' | 'readme' | 'dependencies_yaml' | 'roles_json'> & Partial<Version>): Record<string, string> {
    const team_yml = v.manifest_yaml?.trim() ? v.manifest_yaml
        : v.version ? team_yml_from_derived(v as Version) : null;
    if (!team_yml) return {};
    const files: Record<string, string> = { [TEAM_YML]: team_yml };
    if (v.readme?.trim()) files['README.md'] = v.readme;
    if (v.dependencies_yaml?.trim()) files['dependencies.yml'] = v.dependencies_yaml;
    let roles: Array<{ name?: unknown; content_md?: unknown }> = [];
    try { roles = v.roles_json ? JSON.parse(v.roles_json) : []; } catch { roles = []; }
    for (const r of Array.isArray(roles) ? roles : []) {
        const name = typeof r.name === 'string' ? r.name.replace(/\.md$/, '') : '';
        const path = `roles/${name}.md`;
        if (name && is_bundle_path(path) && typeof r.content_md === 'string') files[path] = r.content_md;
    }
    return files;
}

/**
 * Give every published version without files its files.
 *
 * @param deps - Storage, versions and files.
 */
export async function backfill_team_files(deps: {
    storage: PackageStorage;
    versions: TeamVersionRepository;
    files: TeamFileRepository;
}): Promise<TeamFilesBackfillResult> {
    const result: TeamFilesBackfillResult = { from_zip: [], from_columns: [], empty: [], failed: [] };
    for (const v of await deps.versions.list_published_without_files()) {
        const label = `${v.team_id}@${v.version}`;
        try {
            const key = stored_key(v.package_path);
            const zip = key ? await deps.storage.read(key) : null;
            let files: Record<string, string>;
            if (zip) {
                const all = (await unpack_bundle(zip)).files;
                const left_out = Object.keys(all).filter((p) => !is_bundle_path(p));
                if (left_out.length) log.info('team_files_backfill_left_out', { version: label, paths: left_out });
                files = Object.fromEntries(Object.entries(all).filter(([p]) => is_bundle_path(p)));
            } else {
                files = files_from_columns(v);
            }
            if (!files[TEAM_YML]) {
                result.empty.push(label);
                continue;
            }
            const rows = await write_team_file_objects(deps.storage, v.team_id, Object.entries(files).map(([path, text]) => ({
                path, content_type: team_file_content_type(path), data: Buffer.from(text, 'utf8'),
            })));
            for (const r of rows) r.version_id = v.id;
            await get_sequelize().transaction((t) => deps.files.replace_paths(v.id, rows, t));
            (zip ? result.from_zip : result.from_columns).push(label);
        } catch (err) {
            result.failed.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (result.from_zip.length || result.from_columns.length || result.empty.length || result.failed.length) {
        log.info('team_files_backfill_done', { ...result });
    }
    return result;
}
