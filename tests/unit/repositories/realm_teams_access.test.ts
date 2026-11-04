/**
 * A realm's teams have one owner (PLAN-team-bundle S4.1): `RealmTeamListService`. Everything that asks which teams
 * a realm runs, or whether a team is on a realm, calls it — nothing else imports the model, queries
 * `cliq.realm_teams`, or reads the old `realms.team_list` column. Before S4.1 ten places read that JSON directly and
 * matched it by name in ways that disagreed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../../src');

/** The service, its repository, the model, the model index and the one-time migrations may touch the list. */
const OWNERS = new Set([
    'services/realm_team_list.service.ts',
    'repositories/realm_team_repository.ts',
    'models/realm_team.model.ts',
    'models/index.ts',
]);

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return name === 'migrations' ? [] : sources(full);
        return name.endsWith('.ts') ? [full] : [];
    });
}

/** What reaches the list without the service: the model, the table in SQL, the old JSON column in SQL or a read. */
const BYPASSES: Array<[string, RegExp]> = [
    ['imports the RealmTeam model', /\bimport\b[^;]*\bRealmTeam\b[^;]*from\s+['"][^'"]*models/],
    ['queries cliq.realm_teams', /cliq\.\s*"?realm_teams"?|"realm_teams"/],
    ['reads realms.team_list', /"team_list"|\bteam_list\s+FROM\b|jsonb_array_elements\([^)]*team_list|attributes:\s*\[[^\]]*['"]team_list['"]/],
];

describe("a realm's teams are read only through RealmTeamListService", () => {
    it('nothing else touches the model, the table or the old column', () => {
        const offenders = sources(SRC)
            .filter((file) => !OWNERS.has(relative(SRC, file).split('\\').join('/')))
            .flatMap((file) => {
                // Code only: a comment that names the table or the column is not a bypass.
                const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
                return BYPASSES.filter(([, re]) => re.test(text)).map(([what]) => `${relative(SRC, file)} ${what}`);
            });
        expect(offenders).toEqual([]);
    });

    it('the guard sees a bypass (each pattern matches what it is meant to)', () => {
        expect(BYPASSES[0][1].test("import { RealmTeam } from '../models/index.js';")).toBe(true);
        expect(BYPASSES[1][1].test('SELECT * FROM cliq."realm_teams" rt')).toBe(true);
        expect(BYPASSES[2][1].test('SELECT id, team_list FROM cliq.realms')).toBe(true);
        expect(BYPASSES[2][1].test('jsonb_array_elements(r."team_list") e')).toBe(true);
        // a local variable or a route field named like it is not a bypass
        expect(BYPASSES.some(([, re]) => re.test('const realm_teams = await RealmTeamListService.keys(realm_id);'))).toBe(false);
        expect(BYPASSES.some(([, re]) => re.test("res.json({ ok: true, team_list, install: fanout });"))).toBe(false);
    });
});
