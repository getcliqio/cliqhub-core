/**
 * Semver comparison helpers for team-version ordering.
 *
 * Historical bug: "latest" was computed from `MAX(published_at)`, so
 * publishing an older semver *after* a newer one made the older one
 * win. All catalog logic now sorts by semver instead — this module is
 * the single source of truth.
 *
 * We only need major.minor.patch ordering (plus an optional prerelease
 * suffix), which matches SEMVER_PATTERN in teams_service.ts. Anything
 * that fails to parse is treated as "0.0.0" so it sorts last — this
 * matches Node's `semver` package behavior for `null`/invalid input
 * and keeps the code free of a runtime dependency.
 */

export interface ParsedSemver {
    major: number;
    minor: number;
    patch: number;
    /** Prerelease tag after `-` (e.g. `"beta.1"`). Empty string = stable release. */
    prerelease: string;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?$/;

export function parse_semver(version: string | null | undefined): ParsedSemver | null {
    if (!version) return null;
    const match = SEMVER_RE.exec(version.trim());
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ?? '',
    };
}

/**
 * Compare two semver strings.
 *   < 0  → a is older
 *   = 0  → equal
 *   > 0  → a is newer
 *
 * Unparseable versions sort before all valid versions (so `max()`
 * still returns a valid semver when the DB has some junk row).
 */
export function compare_semver(a: string, b: string): number {
    const pa = parse_semver(a);
    const pb = parse_semver(b);
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;

    if (pa.major !== pb.major) return pa.major - pb.major;
    if (pa.minor !== pb.minor) return pa.minor - pb.minor;
    if (pa.patch !== pb.patch) return pa.patch - pb.patch;

    // Per SemVer 2.0: a prerelease is *older* than the corresponding
    // stable release (e.g. `1.0.0-rc.1 < 1.0.0`). Two prereleases at
    // the same numeric triple compare lexicographically — good enough
    // for our purposes; we don't ship strict SemVer prerelease
    // precedence rules (dot-separated identifier comparison).
    if (pa.prerelease === pb.prerelease) return 0;
    if (pa.prerelease === '') return 1;
    if (pb.prerelease === '') return -1;
    return pa.prerelease < pb.prerelease ? -1 : 1;
}

/**
 * Return the highest semver in `versions`, or `null` if the list is
 * empty. Unparseable strings are skipped.
 */
export function max_semver(versions: readonly string[]): string | null {
    let best: string | null = null;
    for (const v of versions) {
        if (!parse_semver(v)) continue;
        if (best === null || compare_semver(v, best) > 0) best = v;
    }
    return best;
}

/**
 * Return a new array sorted newest-first (descending semver).
 * Unparseable versions are pushed to the end.
 */
export function sort_semver_desc<T extends { version: string }>(rows: readonly T[]): T[] {
    return [...rows].sort((a, b) => compare_semver(b.version, a.version));
}
