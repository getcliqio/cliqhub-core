/**
 * realm_teams_from_json (PLAN-team-bundle S4.1): each realm's JSON team list becomes realm_teams rows by id. A
 * version-less entry gets the team's latest; an entry it can't place is reported and the pass is retried next start.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
    has_column: true,
    realms: [] as Array<{ id: string; team_list: unknown[] }>,
    teams: [{ id: 't-claims', scope: 'acme', name: 'claims' }, { id: 't-hello', scope: 'cliq', name: 'hello-world' }],
    versions: [{ id: 'v-c1', team_id: 't-claims', version: '1.0.0' }],
    inserted: [] as Array<Record<string, unknown>>,
};

vi.mock('../../../src/lib/sequelize.js', () => ({
    get_sequelize: () => ({
        query: async (sql: string, o: { replacements?: Record<string, any> } = {}) => {
            const rep = o.replacements ?? {};
            if (sql.includes('information_schema.columns')) return state.has_column ? [{ '?column?': 1 }] : [];
            if (sql.includes('FROM cliq."realms"')) return state.realms;
            if (sql.includes('FROM cliq."teams"')) return state.teams.filter((t) => t.name === rep.slug && t.scope === rep.scope);
            if (sql.includes('FROM cliq."team_versions"')) return state.versions.filter((v) => v.team_id === rep.team_id && v.version === rep.version);
            if (sql.includes('INSERT INTO cliq."realm_teams"')) { state.inserted.push(rep); return []; }
            throw new Error(`unexpected sql: ${sql}`);
        },
    }),
}));
vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { realm_teams_from_json, REALM_TEAMS_KEY, REALM_TEAMS_REPORT_KEY } from '../../../src/models/migrations/realm_teams_from_json.js';

function settings() {
    const kv = new Map<string, string>();
    return {
        kv,
        repo: {
            find_by_key: async (k: string) => (kv.has(k) ? { key: k, value: kv.get(k) } : null),
            create: async (k: string, v: string) => { kv.set(k, v); },
            update_by_key: async (k: string, v: string) => { kv.set(k, v); },
        } as never,
    };
}
const versions = { find_latest_ref: async (team_id: string) => (team_id === 't-hello' ? { id: 'v-h3', version: '0.3.0' } : null) };

describe('realm_teams_from_json', () => {
    beforeEach(() => {
        state.has_column = true;
        state.inserted = [];
        state.realms = [];
    });

    it('moves named versions and gives a version-less entry the latest; records the pass', async () => {
        state.realms = [{ id: 'r1', team_list: [{ scope: 'acme', slug: 'claims', version: '1.0.0' }, { scope: 'cliq', slug: 'hello-world' }] }];
        const s = settings();
        const out = await realm_teams_from_json({ settings: s.repo, versions });
        expect(out.problems).toEqual([]);
        expect(out.moved).toEqual(['r1 acme/claims@1.0.0', 'r1 cliq/hello-world@0.3.0']);
        expect(state.inserted.map((r) => [r.realm_id, r.team_id, r.version_id])).toEqual([['r1', 't-claims', 'v-c1'], ['r1', 't-hello', 'v-h3']]);
        expect(s.kv.has(REALM_TEAMS_KEY)).toBe(true);
        expect((await realm_teams_from_json({ settings: s.repo, versions })).already).toBe(true);
    });

    it('reports what it cannot place and leaves the pass open for the next start', async () => {
        state.realms = [{ id: 'r1', team_list: [
            { scope: 'acme', slug: 'ghost' },
            { scope: 'acme', slug: 'claims', version: '9.9.9' },
            { scope: 'acme' },
            { scope: 'acme', slug: 'claims', version: '1.0.0' },
        ] }];
        const s = settings();
        const out = await realm_teams_from_json({ settings: s.repo, versions });
        expect(out.problems).toEqual(['r1 acme/ghost: no catalog team', 'r1 acme/claims: version 9.9.9 not found', 'r1 acme/?: no slug']);
        expect(out.moved).toEqual(['r1 acme/claims@1.0.0']);
        expect(s.kv.has(REALM_TEAMS_KEY)).toBe(false);
        expect(JSON.parse(s.kv.get(REALM_TEAMS_REPORT_KEY)!).problems).toHaveLength(3);
    });

    it('with no team_list column there is nothing to move', async () => {
        state.has_column = false;
        const s = settings();
        expect((await realm_teams_from_json({ settings: s.repo, versions })).moved).toEqual([]);
        expect(s.kv.has(REALM_TEAMS_KEY)).toBe(true);
    });
});
