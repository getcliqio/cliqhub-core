/**
 * A daemon's team rows are written in one place (PLAN-team-bundle S4.2): `TeamService.install_slot`, when the hub
 * installs a realm team onto a daemon. Nothing else creates `daemon_teams` rows, so Core never takes an id from a
 * daemon and never records a team that isn't a realm team.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../../src');

/** The slot service and the repository/model it uses; one-time migrations re-key rows, they don't create them. */
const OWNERS = new Set([
    'services/teams_install_service.ts',
    'repositories/daemon_team_repository.ts',
    'models/daemon_team.model.ts',
]);

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return name === 'migrations' ? [] : sources(full);
        return name.endsWith('.ts') ? [full] : [];
    });
}

/** What creates a row: the model's create/bulkCreate/upsert, a DaemonTeamRepository create, raw INSERT. */
const CREATES: Array<[string, RegExp]> = [
    ['DaemonTeam.create / bulkCreate / upsert', /\bDaemonTeam\s*\.\s*(?:unscoped\(\)\s*\.\s*)?(?:create|bulkCreate|upsert|findOrCreate)\s*\(/],
    ['a DaemonTeamRepository create', /new DaemonTeamRepository\(\)\s*\.\s*create/],
    ['INSERT INTO daemon_teams', /INSERT\s+INTO\s+(?:cliq\.)?"?daemon_teams"?/i],
];

describe('daemon_teams rows are created only by TeamService.install_slot', () => {
    it('no other code creates a row', () => {
        const offenders = sources(SRC)
            .filter((file) => !OWNERS.has(relative(SRC, file).split('\\').join('/')))
            .flatMap((file) => {
                const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
                const repo_vars = [...text.matchAll(/const\s+(\w+)\s*=\s*new DaemonTeamRepository\(\)/g)].map((m) => m[1]);
                const repo_create = repo_vars.some((v) => new RegExp(`\\b${v}\\s*\\.\\s*create`).test(text));
                return [
                    ...CREATES.filter(([, re]) => re.test(text)).map(([what]) => `${relative(SRC, file)} ${what}`),
                    ...(repo_create ? [`${relative(SRC, file)} a DaemonTeamRepository create`] : []),
                ];
            });
        expect(offenders).toEqual([]);
    });

    it('the slot service creates rows in install_slot only', () => {
        const text = readFileSync(join(SRC, 'services/teams_install_service.ts'), 'utf8');
        const creates = [...text.matchAll(/_dt_repo_ti\.create_one\(/g)].length;
        expect(creates).toBe(1);
        const install_slot = text.slice(text.indexOf('static async install_slot('), text.indexOf('static async register_from_daemon('));
        expect(install_slot).toContain('_dt_repo_ti.create_one(');
        // The id is Core's, never one the caller passes in.
        expect(install_slot).toMatch(/const id = randomUUID\(\)/);
    });

    it('the guard sees a create (each pattern matches what it is meant to)', () => {
        expect(CREATES[0][1].test('await DaemonTeam.create({ id })')).toBe(true);
        expect(CREATES[0][1].test('DaemonTeam.unscoped().bulkCreate(rows)')).toBe(true);
        expect(CREATES[2][1].test('INSERT INTO cliq."daemon_teams" (id) VALUES')).toBe(true);
        expect(CREATES.some(([, re]) => re.test('await DaemonTeam.findOne({ where })'))).toBe(false);
    });
});
