/**
 * RealmTeamListService over `realm_teams` (PLAN-team-bundle S4.1): the reads every caller uses, and the writes that
 * put a team on a realm at a version, move it, and take it off. The table is an in-memory fake with the
 * repository's shape (one row per realm and team).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = { id: string; realm_id: string; team_id: string; version_id: string; scope: string; slug: string; version: string };

/** The catalog: two teams, their published versions (latest last). */
const CATALOG = {
    teams: [
        { id: 't-claims', scope: 'acme', name: 'claims', org_id: 'org-1' },
        { id: 't-hello', scope: 'cliq', name: 'hello-world', org_id: null },
    ],
    versions: [
        { id: 'v-c1', team_id: 't-claims', version: '1.0.0' },
        { id: 'v-c2', team_id: 't-claims', version: '2.0.0' },
        { id: 'v-h1', team_id: 't-hello', version: '0.1.0' },
    ],
};
const REALM_ORG: Record<string, string> = { r1: 'org-1', r2: 'org-1', r3: 'org-2' };

const db = { rows: [] as Row[] };
const label = (team_id: string, version_id: string) => {
    const t = CATALOG.teams.find((x) => x.id === team_id)!;
    return { scope: t.scope, slug: t.name, version: CATALOG.versions.find((v) => v.id === version_id)!.version };
};

vi.mock('../../../src/repositories/realm_team_repository.js', () => ({
    RealmTeamRepository: class {
        async list(realm_id: string) { return db.rows.filter((r) => r.realm_id === realm_id); }
        async list_for(ids: string[]) { return db.rows.filter((r) => ids.includes(r.realm_id)); }
        async find(realm_id: string, team_id: string) { return db.rows.find((r) => r.realm_id === realm_id && r.team_id === team_id) ?? null; }
        async realm_ids_with(team_id: string, org_id?: string) {
            return db.rows.filter((r) => r.team_id === team_id && (!org_id || REALM_ORG[r.realm_id] === org_id)).map((r) => r.realm_id);
        }
        async put(realm_id: string, team_id: string, version_id: string) {
            const row = db.rows.find((r) => r.realm_id === realm_id && r.team_id === team_id);
            if (row) Object.assign(row, { version_id }, label(team_id, version_id));
            else db.rows.push({ id: `rt-${db.rows.length}`, realm_id, team_id, version_id, ...label(team_id, version_id) });
        }
        async take_off(realm_id: string, team_id: string) {
            const before = db.rows.length;
            db.rows = db.rows.filter((r) => !(r.realm_id === realm_id && r.team_id === team_id));
            return db.rows.length < before;
        }
        async take_off_realms(team_id: string, realm_ids: string[]) {
            db.rows = db.rows.filter((r) => !(r.team_id === team_id && realm_ids.includes(r.realm_id)));
        }
        async take_off_everywhere(team_id: string) {
            const ids = db.rows.filter((r) => r.team_id === team_id).map((r) => r.realm_id);
            db.rows = db.rows.filter((r) => r.team_id !== team_id);
            return ids;
        }
    },
}));
vi.mock('../../../src/repositories/team_repository.js', () => ({
    TeamRepository: class {
        async find_by_name_and_scope(name: string, scope: string) { return CATALOG.teams.find((t) => t.name === name && t.scope === scope) ?? null; }
        async find_by_id(id: string) { return CATALOG.teams.find((t) => t.id === id) ?? null; }
    },
}));
vi.mock('../../../src/repositories/team_version_repository.js', () => ({
    TeamVersionRepository: class {
        async find_current_by_team_and_version(team_id: string, version: string) { return CATALOG.versions.find((v) => v.team_id === team_id && v.version === version) ?? null; }
        async find_latest_ref(team_id: string) { return CATALOG.versions.filter((v) => v.team_id === team_id).at(-1) ?? null; }
        async find_current_by_id(id: string) { return CATALOG.versions.find((v) => v.id === id) ?? null; }
    },
}));
vi.mock('../../../src/repositories/realm_repository.js', () => ({
    RealmRepository: class { async find_by_id(id: string) { return REALM_ORG[id] ? { id, org_id: REALM_ORG[id] } : null; } },
}));
const slots = { updates: [] as unknown[] };
vi.mock('../../../src/repositories/daemon_team_repository.js', () => ({
    DaemonTeamRepository: class { async update_where(where: unknown, set: unknown) { slots.updates.push({ where, set }); } },
}));
vi.mock('../../../src/repositories/scope_repository.js', () => ({
    ScopeRepository: class { async find_one_q({ where }: { where: { slug: string } }) { return { id: `scope-${where.slug}` }; } },
}));
vi.mock('../../../src/repositories/daemon_repository.js', () => ({ DaemonRepository: class {} }));
vi.mock('../../../src/repositories/realm_agent_setting_repository.js', () => ({ RealmAgentSettingRepository: class {} }));
vi.mock('../../../src/repositories/org_agent_setting_repository.js', () => ({ OrgAgentSettingRepository: class {} }));
vi.mock('../../../src/services/dispatch.service.js', () => ({ DispatchService: {} }));
vi.mock('../../../src/services/command_outbox.service.js', () => ({ command_outbox_enqueue: vi.fn() }));
vi.mock('../../../src/services/in_app_notification.service.js', () => ({ InAppNotificationService: {} }));
const mesh = { changed: vi.fn(async (_realm_id: string) => undefined) };
vi.mock('../../../src/services/mesh_lifecycle.service.js', () => ({ MeshLifecycleService: { on_skills_changed: (id: string) => mesh.changed(id) } }));
vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { RealmTeamListService } from '../../../src/services/realm_team_list.service.js';

describe('RealmTeamListService over realm_teams', () => {
    beforeEach(() => {
        db.rows = [];
        slots.updates = [];
        mesh.changed.mockClear();
    });

    it('add puts a team on at the latest version, or the one asked for; the list carries ids and names', async () => {
        expect(await RealmTeamListService.add('r1', 'u', { team_id: 't-claims' }))
            .toEqual([{ team_id: 't-claims', version_id: 'v-c2', scope: 'acme', slug: 'claims', version: '2.0.0' }]);
        await RealmTeamListService.add('r2', 'u', { team_id: 't-claims', version_id: 'v-c1' });
        expect(db.rows.map((r) => [r.realm_id, r.team_id, r.version_id])).toEqual([['r1', 't-claims', 'v-c2'], ['r2', 't-claims', 'v-c1']]);
    });

    it('add of a team already on the realm moves its version; it stays one row', async () => {
        await RealmTeamListService.add('r1', 'u', { team_id: 't-claims', version_id: 'v-c1' });
        await RealmTeamListService.add('r1', 'u', { team_id: 't-claims' });
        expect(db.rows).toHaveLength(1);
        expect(db.rows[0].version_id).toBe('v-c2');
    });

    it("add says what is wrong: unknown realm, team or version, or another team's version", async () => {
        await expect(RealmTeamListService.add('nope', 'u', { team_id: 't-claims' })).rejects.toMatchObject({ status_code: 404 });
        await expect(RealmTeamListService.add('r1', 'u', { team_id: 't-ghost' })).rejects.toThrow(/Team not found/);
        await expect(RealmTeamListService.add('r1', 'u', { team_id: 't-claims', version_id: 'v-none' })).rejects.toThrow(/doesn't exist or was withdrawn/);
        await expect(RealmTeamListService.add('r1', 'u', { team_id: 't-claims', version_id: 'v-h1' })).rejects.toThrow(/doesn't exist or was withdrawn/);
        expect(db.rows).toEqual([]);
    });

    it('remove takes the team off; removing again is a no-op', async () => {
        await RealmTeamListService.add('r1', 'u', { team_id: 't-claims' });
        await RealmTeamListService.add('r1', 'u', { team_id: 't-hello' });
        expect(await RealmTeamListService.remove('r1', 'u', 't-claims'))
            .toEqual([{ team_id: 't-hello', version_id: 'v-h1', scope: 'cliq', slug: 'hello-world', version: '0.1.0' }]);
        await vi.waitFor(() => expect(mesh.changed).toHaveBeenCalledTimes(3)); // two adds and the remove tell the mesh
        await RealmTeamListService.remove('r1', 'u', 't-claims');
        await new Promise((r) => setTimeout(r, 10));
        expect(mesh.changed).toHaveBeenCalledTimes(3);
    });

    it('seed_builtin_teams adds hello-world at its latest version, once', async () => {
        await RealmTeamListService.seed_builtin_teams('r1');
        await RealmTeamListService.seed_builtin_teams('r1');
        expect(db.rows.map((r) => [r.team_id, r.version_id])).toEqual([['t-hello', 'v-h1']]);
    });

    it('the reads: entries, entries_for, keys, find, has, has_ref, realms_with', async () => {
        await RealmTeamListService.add('r1', 'u', { team_id: 't-claims' });
        await RealmTeamListService.add('r3', 'u', { team_id: 't-claims', version_id: 'v-c1' });
        expect((await RealmTeamListService.entries('r1')).map((e) => e.version)).toEqual(['2.0.0']);
        const by_realm = await RealmTeamListService.entries_for(['r1', 'r2']);
        expect([...by_realm.keys()]).toEqual(['r1', 'r2']);
        expect(by_realm.get('r2')).toEqual([]);
        expect([...await RealmTeamListService.keys('r1')]).toEqual(['acme/claims']);
        expect((await RealmTeamListService.find('r3', 't-claims'))?.version_id).toBe('v-c1');
        expect(await RealmTeamListService.has('r2', 't-claims')).toBe(false);
        expect(await RealmTeamListService.has_ref('r1', 'acme', 'claims')).toBe(true);
        expect(await RealmTeamListService.has_ref('r1', 'acme', 'ghost')).toBe(false);
        expect(await RealmTeamListService.realms_with('t-claims')).toEqual(['r1', 'r3']);
        expect(await RealmTeamListService.realms_with('t-claims', 'org-2')).toEqual(['r3']);
    });

    it('take_off_realms takes a team off only the realms named', async () => {
        for (const r of ['r1', 'r2', 'r3']) await RealmTeamListService.add(r, 'u', { team_id: 't-claims' });
        await RealmTeamListService.take_off_realms('t-claims', ['r1', 'r3']);
        expect(db.rows.map((r) => r.realm_id)).toEqual(['r2']);
    });

    it('remove_from_all_realms takes the team off every realm and marks its slots uninstalled', async () => {
        await RealmTeamListService.add('r1', 'u', { team_id: 't-claims' });
        await RealmTeamListService.add('r1', 'u', { team_id: 't-hello' });
        await RealmTeamListService.add('r3', 'u', { team_id: 't-claims' });
        await RealmTeamListService.remove_from_all_realms('acme', 'claims');
        expect(db.rows.map((r) => r.team_id)).toEqual(['t-hello']);
        expect(slots.updates).toEqual([{ where: { team_id: 't-claims' }, set: expect.objectContaining({ uninstalled_at: expect.any(Number) }) }]);
    });
});
