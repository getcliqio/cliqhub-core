/**
 * Raw SQL reads of team_versions see published versions only (PLAN-team-bundle S1.3b/S1.3c).
 *
 * A draft is a team_versions row with no number. Sequelize reads go through the version
 * repository's PUBLISHED filter; raw SQL doesn't, and a draft there sorts first in a
 * `version DESC` (NULLs first), so a team with an open draft showed no latest version and
 * couldn't be installed. Every raw query on team_versions has to say which rows it reads.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../../src');

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return name === 'migrations' ? [] : sources(full);
        return name.endsWith('.ts') ? [full] : [];
    });
}

/** Each raw read of team_versions: from its FROM / JOIN to the end of the SQL string it is in. */
function raw_reads(text: string): string[] {
    const reads: string[] = [];
    for (const m of text.matchAll(/\b(FROM|JOIN)\s+(cliq\.)?"?team_versions"?/g)) {
        const rest = text.slice(m.index);
        const end = rest.search(/`|'[,)]/);
        reads.push(end === -1 ? rest : rest.slice(0, end));
    }
    return reads;
}

describe('raw SQL on team_versions', () => {
    it('every read filters on status', () => {
        const unfiltered = sources(SRC).flatMap((file) =>
            raw_reads(readFileSync(file, 'utf8'))
                .filter((sql) => !/\bstatus"?\s*=/.test(sql))
                .map((sql) => `${relative(SRC, file)}: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`));
        expect(unfiltered).toEqual([]);
    });

    it('finds the reads it guards (the check is not vacuous)', () => {
        const all = sources(SRC).flatMap((file) => raw_reads(readFileSync(file, 'utf8')));
        expect(all.length).toBeGreaterThanOrEqual(5);
    });
});
