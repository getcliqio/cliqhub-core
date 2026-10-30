/**
 * One time (Oct 2026, PLAN-team-bundle S1.2): every published version's zip moves from `<name>-<version>.zip`
 * (no scope: same-named teams in different scopes overwrote each other) to
 * `teams/<team_id>/versions/<version_id>.zip`.
 *
 * Each zip is copied, read back and compared before its version row points at the new key; the old key is
 * kept (S1.5 deletes old keys). Versions with no zip (`draft://…`, built-ins seeded without one) are listed and
 * left for S1.5, which builds theirs. The key is recorded once a pass finishes; until then it is safe to repeat,
 * and versions already on an id key are skipped.
 */
import { get_logger } from '../../lib/log.js';
import type { SettingsRepository } from '../../repositories/settings_repository.js';
import type { TeamVersionRepository } from '../../repositories/team_version_repository.js';
import { version_zip_key, type PackageStorage } from '../../storage/package_storage.js';

/** Where a zip sat before S1.2: `<name>-<version>.zip`, stored as that key or a local path ending in it. */
function old_key(package_path: string): string {
    return package_path.split('/').pop() || package_path;
}

const log = get_logger('db.migrate');

/** `cliq.settings` key marking this migration as done. */
export const TEAM_ZIPS_BY_ID_MIGRATION_KEY = 'migrate.team_zips_by_id_2026_10';

/** What a pass did. */
export interface TeamZipsByIdResult {
    moved: number;
    /** `<team_id>@<version>` of versions with no zip to move. */
    missing: string[];
    /** True when the migration had already run. */
    skipped: boolean;
}

/**
 * Move every version's zip to its id key.
 *
 * @param deps - Storage, versions and settings.
 * @returns How many zips moved and which versions had none.
 */
export async function migrate_team_zips_by_id(deps: {
    storage: PackageStorage;
    versions: TeamVersionRepository;
    settings: SettingsRepository;
}): Promise<TeamZipsByIdResult> {
    if (await deps.settings.find_by_key(TEAM_ZIPS_BY_ID_MIGRATION_KEY)) return { moved: 0, missing: [], skipped: true };

    let moved = 0;
    const missing: string[] = [];
    for (const v of await deps.versions.list_all_packages()) {
        if (v.package_path.startsWith('teams/')) continue;
        const data = v.package_path && !v.package_path.startsWith('draft://')
            ? await deps.storage.read(old_key(v.package_path))
            : null;
        if (!data) {
            missing.push(`${v.team_id}@${v.version}`);
            continue;
        }
        const key = version_zip_key(v.team_id, v.id);
        await deps.storage.write(key, data);
        const back = await deps.storage.read(key);
        if (!back || !back.equals(data)) throw new Error(`zip for ${v.team_id}@${v.version} didn't read back from ${key}`);
        await deps.versions.update_package_path(v.id, key);
        moved += 1;
    }

    await deps.settings.create(TEAM_ZIPS_BY_ID_MIGRATION_KEY, JSON.stringify({ moved, missing, at: new Date().toISOString() }));
    log.info('team_zips_by_id_done', { moved, missing });
    return { moved, missing, skipped: false };
}
