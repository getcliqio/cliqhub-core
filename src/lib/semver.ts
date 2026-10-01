/**
 * SemVer — semantic version parsing, comparison, and sorting.
 *
 * All methods are pure and operate on version strings in `MAJOR.MINOR.PATCH`
 * format (pre-release and build-metadata suffixes are accepted but ignored).
 *
 * `parse`     — string → `ParsedSemver` (or null for non-semver input).
 * `compare`   — total order comparison, safe to pass to `Array.sort`.
 * `max`       — pick the highest version from a list.
 * `sort_desc` — sort a version list highest-first, in-place.
 */

export interface ParsedSemver {
    major: number;
    minor: number;
    patch: number;
    /** Prerelease tag after `-` (e.g. `"beta.1"`). Empty string = stable release. */
    prerelease: string;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?$/;

export class SemVer {
    /**
     * Parse a semver string into its numeric components.
     *
     * @param version - A string like `"1.2.3"` or `"2.0.0-beta.1"`.
     * @returns Parsed object, or `null` for non-semver input.
     */
    static parse(version: string | null | undefined): ParsedSemver | null {
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
     * Compare two version strings for sort order.
     *
     * Returns a negative number if `a < b`, positive if `a > b`, zero if equal.
     * Non-parseable versions sort before valid ones. Safe to pass to `Array.sort`.
     */
    static compare(a: string, b: string): number {
        const pa = SemVer.parse(a);
        const pb = SemVer.parse(b);
        if (!pa && !pb) return 0;
        if (!pa) return -1;
        if (!pb) return 1;

        if (pa.major !== pb.major) return pa.major - pb.major;
        if (pa.minor !== pb.minor) return pa.minor - pb.minor;
        if (pa.patch !== pb.patch) return pa.patch - pb.patch;

        if (pa.prerelease === pb.prerelease) return 0;
        if (pa.prerelease === '') return 1;
        if (pb.prerelease === '') return -1;
        return pa.prerelease < pb.prerelease ? -1 : 1;
    }

    /**
     * Return the highest version string from a list, or `null` for an empty list.
     * Non-parseable entries are skipped.
     */
    static max(versions: readonly string[]): string | null {
        let best: string | null = null;
        for (const v of versions) {
            if (!SemVer.parse(v)) continue;
            if (best === null || SemVer.compare(v, best) > 0) best = v;
        }
        return best;
    }

    /**
     * Return a new array of `rows` sorted by `version` descending (highest first).
     * The original array is not mutated.
     */
    static sort_desc<T extends { version: string }>(rows: readonly T[]): T[] {
        return [...rows].sort((a, b) => SemVer.compare(b.version, a.version));
    }
}
