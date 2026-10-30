/**
 * A version's content, read from its files (PLAN-team-bundle S1.4b): what CliqHub shows and checks about a team
 * version — team page, Files tab, Run form inputs, diagram, install and agent checks — comes from here, derived
 * the way publish derives it (`derive_version_content`). A published version never changes, so its content is
 * cached by `version_id`; a draft is read fresh each time.
 *
 * Module-level like the repositories it sits on; the container gives it storage at startup.
 */
import type { TeamFileRepository } from '../repositories/team_file_repository.js';
import type { TeamVersionRepository } from '../repositories/team_version_repository.js';
import type { PackageStorage } from '../storage/package_storage.js';
import { derive_version_content, type VersionContentFields } from './package_parser.js';
import { read_team_files } from './team_file_objects.js';

/** A version's content, and which version it is. */
export interface VersionContent extends VersionContentFields {
    version_id: string;
}

/** Published versions kept in memory (each is a few KB of text). */
const CACHE_MAX = 1000;
/** Versions read at once when many are asked for. */
const BATCH = 8;

let storage: PackageStorage | null = null;
const cache = new Map<string, VersionContent>();
/** Loaded on first use, not at import: importing this module (from many services) touches no model. */
let files_repo: TeamFileRepository | null = null;
let versions_repo: TeamVersionRepository | null = null;
const files = async () => (files_repo ??= new (await import('../repositories/team_file_repository.js')).TeamFileRepository());
const versions = async () => (versions_repo ??= new (await import('../repositories/team_version_repository.js')).TeamVersionRepository());

/** Give the reader its storage (container startup). */
export function init_version_content(s: PackageStorage): void {
    storage = s;
}

/** Forget cached content (tests). */
export function clear_version_content_cache(): void {
    cache.clear();
}

/**
 * A version's content, from its files. Null when it has no files.
 *
 * @param version_id - A draft or published version.
 * @throws ApiError when a file's bytes are missing, don't match, or aren't text.
 */
export async function version_content(version_id: string): Promise<VersionContent | null> {
    const hit = cache.get(version_id);
    if (hit) {
        cache.delete(version_id);
        cache.set(version_id, hit);
        return hit;
    }
    if (!storage) throw new Error('version_content: no storage (init_version_content was not called)');
    const rows = await (await files()).list_by_version(version_id);
    if (!rows.length) return null;
    const content: VersionContent = { version_id, ...derive_version_content(await read_team_files(storage, rows)) };
    const { TeamVersion } = await import('../models/index.js');
    const row = await TeamVersion.findOne({ where: { id: version_id }, attributes: ['status'], raw: true }) as { status?: string } | null;
    if (row?.status === 'published') {
        cache.set(version_id, content);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    }
    return content;
}

/** Several versions' content (a few at a time), by version id; versions without files are left out. */
export async function version_contents(version_ids: string[]): Promise<Map<string, VersionContent>> {
    const out = new Map<string, VersionContent>();
    const ids = [...new Set(version_ids)];
    for (let i = 0; i < ids.length; i += BATCH) {
        const got = await Promise.all(ids.slice(i, i + BATCH).map((id) => version_content(id)));
        for (const c of got) if (c) out.set(c.version_id, c);
    }
    return out;
}

/** A team's latest published version and its content, or null when it has none. */
export async function latest_version_content(team_id: string): Promise<(VersionContent & { version: string }) | null> {
    const ref = await (await versions()).find_latest_ref(team_id);
    const content = ref ? await version_content(ref.id) : null;
    return content && ref ? { ...content, version: ref.version } : null;
}
