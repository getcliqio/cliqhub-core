/**
 * Every startup until it has run (PLAN-team-bundle S1.5c): storage holds one copy of each published version.
 *
 *   1. Every published version gets its zip at `teams/<team_id>/versions/<version_id>.zip`, as its first download
 *      would: built from its files, written, read back and compared, and its row pointed at it. A version already
 *      there is read to check the zip is readable.
 *   2. Each zip left at the top of the store from before S1.2 (`<name>-<version>.zip`, no scope) is deleted
 *      **only when its files are exactly the files of a published version with that name and number**: the same
 *      paths, each with the same text. Anything else (no such version, a path that isn't part of a team, different
 *      text, a zip that won't open) is kept. One no published version uses any more (its team or version was
 *      removed) is moved to `attic/<key>` (copied, read back, then removed from the top), by decision (2 Nov):
 *      nothing is lost and it can be deleted by hand later.
 *   3. When every version has its zip and no old zip is kept, the pass is recorded and not repeated. Otherwise
 *      what's left is logged and stored under {@link OLD_ZIP_KEYS_REPORT_KEY}, and the next start tries again.
 */
import { pack_bundle, unpack_bundle } from '@getcliqio/cliq-sdk';
import { in_parallel } from '../../lib/in_parallel.js';
import { get_logger } from '../../lib/log.js';
import type { SettingsRepository } from '../../repositories/settings_repository.js';
import type { TeamFileRepository } from '../../repositories/team_file_repository.js';
import type { TeamVersionRepository } from '../../repositories/team_version_repository.js';
import { read_team_files } from '../../services/team_file_objects.js';
import { stored_key, version_zip_key, type PackageStorage } from '../../storage/package_storage.js';

const log = get_logger('db.migrate');

/** `cliq.settings` key recording that every old zip is gone. */
export const OLD_ZIP_KEYS_KEY = 'migrate.old_zip_keys_2026_11';
/** `cliq.settings` key holding the last pass's leftovers when there were any. */
export const OLD_ZIP_KEYS_REPORT_KEY = 'migrate.old_zip_keys_report';

/** What a pass did. */
export interface OldZipKeysResult {
    /** True when an earlier pass had finished. */
    already: boolean;
    /** `<team_id>@<version>` whose zip this pass built. */
    built: string[];
    /** Old keys deleted. */
    deleted: string[];
    /** Old keys no version uses, moved to `attic/<key>`. */
    attic: string[];
    /** `<key or team_id@version>: <why>` left in place. */
    kept: string[];
}

/** The same files: the same paths, each with the same text. */
function same_files(a: Record<string, string>, b: Record<string, string>): boolean {
    const keys = Object.keys(a).sort();
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && a[k] === b[k]);
}

type Deps = { storage: PackageStorage; versions: TeamVersionRepository; files: TeamFileRepository };

/**
 * Step 1 on its own (it changes nothing an older Core reads, so startup runs it before anything is dropped): every
 * published version's zip by id, built where missing. Returns each version's files for step 2.
 *
 * @param deps - Storage, versions and files.
 */
export async function build_version_zips(deps: Deps): Promise<{
    versions: Awaited<ReturnType<TeamVersionRepository['list_published_packages']>>;
    files_of: Map<string, Record<string, string>>;
    built: string[];
    kept: string[];
}> {
    const versions = await deps.versions.list_published_packages();
    const files_of = new Map<string, Record<string, string>>();
    const built: string[] = [];
    const kept: string[] = [];
    await in_parallel(versions, 8, async (v) => {
        const label = `${v.team_id}@${v.version}`;
        try {
            const files = await read_team_files(deps.storage, await deps.files.list_by_version(v.id));
            files_of.set(v.id, files);
            const key = stored_key(v.package_path);
            if (key && await deps.storage.read(key)) return;
            if (!Object.keys(files).length) {
                kept.push(`${label}: no files to build its zip from`);
                return;
            }
            const zip = await pack_bundle({ files });
            const new_key = version_zip_key(v.team_id, v.id);
            await deps.storage.write(new_key, zip);
            const back = await deps.storage.read(new_key);
            if (!back || !back.equals(zip)) throw new Error(`didn't read back from ${new_key}`);
            await deps.versions.update_package_path(v.id, new_key);
            built.push(label);
        } catch (err) {
            kept.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    if (built.length) log.info('version_zips_built', { built: built.length });
    return { versions, files_of, built: built.sort(), kept: kept.sort() };
}

/**
 * Give every published version its zip by id, then delete the old zips that hold nothing those versions don't.
 *
 * @param deps - Storage, versions, files and settings.
 */
export async function drop_old_zip_keys(deps: Deps & { settings: SettingsRepository }): Promise<OldZipKeysResult> {
    if (await deps.settings.find_by_key(OLD_ZIP_KEYS_KEY)) return { already: true, built: [], deleted: [], attic: [], kept: [] };

    // 1. Every published version's zip by id; its files, for step 2.
    const { versions, files_of, built, kept } = await build_version_zips(deps);
    const result: OldZipKeysResult = { already: false, built, deleted: [], attic: [], kept };

    // 2. Old zips: deleted only where a version holds exactly what they hold.
    const by_old_key = new Map<string, string[]>();
    for (const v of versions) {
        const key = `${v.team_name}-${v.version}.zip`;
        by_old_key.set(key, [...(by_old_key.get(key) ?? []), v.id]);
    }
    await in_parallel((await deps.storage.list_top()).filter((k) => k.endsWith('.zip')), 8, async (key) => {
        const ids = by_old_key.get(key) ?? [];
        try {
            const data = await deps.storage.read(key);
            if (!data) return;
            if (!ids.length) {
                const attic_key = `attic/${key}`;
                await deps.storage.write(attic_key, data);
                const back = await deps.storage.read(attic_key);
                if (!back || !back.equals(data)) throw new Error(`didn't read back from ${attic_key}`);
                await deps.storage.delete(key);
                result.attic.push(key);
                return;
            }
            const old_files = (await unpack_bundle(data)).files;
            if (!ids.some((id) => { const f = files_of.get(id); return f && same_files(old_files, f); })) {
                result.kept.push(`${key}: its files differ from every version with this name and number`);
                return;
            }
            await deps.storage.delete(key);
            result.deleted.push(key);
        } catch (err) {
            result.kept.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    for (const list of [result.deleted, result.attic, result.kept]) list.sort();

    // 3. Recorded once nothing is left; otherwise reported.
    const report = JSON.stringify({ at: new Date().toISOString(), versions: versions.length, ...result });
    if (result.kept.length) {
        log.error('old_zip_keys_kept', { built: result.built.length, deleted: result.deleted.length, attic: result.attic.length, kept: result.kept.slice(0, 50), total_kept: result.kept.length });
        if (await deps.settings.find_by_key(OLD_ZIP_KEYS_REPORT_KEY)) await deps.settings.update_by_key(OLD_ZIP_KEYS_REPORT_KEY, report);
        else await deps.settings.create(OLD_ZIP_KEYS_REPORT_KEY, report);
    } else {
        await deps.settings.create(OLD_ZIP_KEYS_KEY, report);
        log.info('old_zip_keys_done', { versions: versions.length, built: result.built.length, deleted: result.deleted.length, attic: result.attic });
    }
    return result;
}
