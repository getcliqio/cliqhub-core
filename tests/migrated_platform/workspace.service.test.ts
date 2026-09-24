import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hub_legacy_uuid } from '../../src/lib/hub_legacy_uuid.js';

import { WorkspaceService } from '../../src/services/workspace.service.js';
import { close_test_control_plane_store, open_test_control_plane_store, postgres_reachable } from './helpers/control_plane_store.js';
import { Daemon, Workspace, WorkspaceTeam, Team, Scope, Run } from '../../src/models/index.js';
import { randomUUID } from 'node:crypto';

const has_postgres = await postgres_reachable();

const uid = () => `test-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const uid_path = () => `/tmp/test-workspace/${uid()}`;

let scope_id: string;
let team_id: string;
const daemon_id = randomUUID();

beforeAll(async () => {
    if (!has_postgres) return;
    process.env.CLIQ_BFF_LOG_LEVEL = 'error';
    await open_test_control_plane_store();

    scope_id = randomUUID();
    await Scope.create({
        id: scope_id,
        slug: `ws-test-scope-${Date.now()}`,
        name: 'WS Test Scope',
        is_default: 0,
        created_at: Date.now(),
    });

    team_id = randomUUID();
    await Team.create({
        id: team_id,
        scope_id,
        slug: `ws-test-team-${Date.now()}`,
        version: null,
        description: null,
        manifest: '{}',
        dockerfile: null,
        dependencies: null,
        created_at: Date.now(),
        updated_at: Date.now(),
    });
    await Daemon.create({
        id: daemon_id,
        api_key_hash: 'workspace-service-test',
        user_id: hub_legacy_uuid(1),
        user_email: 'platform@test.local',
        hostname: 'workspace-service-test',
        ip: null,
        port: null,
        public_url: null,
        status: 'online',
        last_heartbeat: Date.now(),
        capacity: 5,
        created_at: Date.now(),
        last_registered_at: Date.now(),
    });
});

const created_paths: string[] = [];

async function track_upsert(path: string, name?: string | null, daemon_id?: string | null) {
    created_paths.push(path);
    return WorkspaceService.upsert_by_path(path, name, daemon_id);
}

async function cleanup_test_workspaces() {
    for (const p of created_paths) {
        const ws = await Workspace.findOne({ where: { path: p } });
        if (!ws) continue;
        const id = ws.get('id') as string;
        await Run.destroy({ where: { workspace_id: id } });
        await WorkspaceTeam.destroy({ where: { workspace_id: id } });
        await Workspace.destroy({ where: { id } });
    }
    created_paths.length = 0;
}

beforeEach(async () => {
    if (!has_postgres) return;
    await cleanup_test_workspaces();
});

afterAll(async () => {
    if (!has_postgres) return;
    await cleanup_test_workspaces();
    await Team.destroy({ where: { id: team_id } });
    await Scope.destroy({ where: { id: scope_id } });
    await Daemon.destroy({ where: { id: daemon_id } });
    await close_test_control_plane_store();
});

describe.skipIf(!has_postgres)('WorkspaceService.list', () => {
    it('returns workspaces array', async () => {
        const result = await WorkspaceService.list();
        expect(Array.isArray(result.workspaces)).toBe(true);
        expect(typeof result.total).toBe('number');
    });

    it('filters by daemon_id when provided', async () => {
        const path = uid_path();
        await track_upsert(path, 'daemon-ws');
        await Workspace.update({ daemon_id }, { where: { path } });

        const filtered = await WorkspaceService.list({ daemon_id });
        expect(filtered.workspaces.some((w) => w.path === path)).toBe(true);
    });

    it('includes teams and run metadata when workspace has teams and runs', async () => {
        const path = uid_path();
        const { record: ws } = await track_upsert(path, 'enriched');
        await WorkspaceService.add_team(ws.id, team_id);

        const { RunService } = await import('../../src/services/run.service.js');
        await RunService.create(ws.id, team_id, { run_name: `ws-run-${uid()}` });

        const listed = await WorkspaceService.list();
        const found = listed.workspaces.find((w) => w.path === path);
        expect(found?.teams.length).toBeGreaterThanOrEqual(1);
        expect(found?.assembled).toBe(true);
        expect(found?.active_runs.length).toBeGreaterThanOrEqual(1);
        expect(found?.latest_run).not.toBeNull();
    });

    it('includes workspaces ordered by created_at ASC', async () => {
        const path_1 = uid_path();
        const path_2 = uid_path();
        await track_upsert(path_1, 'first');
        await track_upsert(path_2, 'second');

        const result = await WorkspaceService.list();
        expect(result.workspaces.length).toBeGreaterThanOrEqual(2);
    });
});

describe.skipIf(!has_postgres)('WorkspaceService.find_by_path', () => {
    it('returns null for unknown path', async () => {
        expect(await WorkspaceService.find_by_path('/missing/path')).toBeNull();
    });

    it('returns enriched workspace for existing path', async () => {
        const path = uid_path();
        await track_upsert(path, 'find-me');
        const found = await WorkspaceService.find_by_path(path);
        expect(found?.path).toBe(path);
    });
});

describe.skipIf(!has_postgres)('WorkspaceService.remove_by_path', () => {
    it('removes workspace by path', async () => {
        const path = uid_path();
        await track_upsert(path);
        const removed = await WorkspaceService.remove_by_path(path);
        expect(removed).toBe(true);
    });
});

describe.skipIf(!has_postgres)('WorkspaceService.get', () => {
    it('returns workspace by id', async () => {
        const path = uid_path();
        const { record } = await track_upsert(path, 'my-ws');

        const ws = await WorkspaceService.get(record.id);
        expect(ws.path).toBe(path);
        expect(ws.name).toBe('my-ws');
    });

    it('throws 404 for unknown id', async () => {
        await expect(WorkspaceService.get(randomUUID()))
            .rejects.toThrow(/not found/);
    });
});

describe.skipIf(!has_postgres)('WorkspaceService.get_by_path', () => {
    it('returns workspace by path', async () => {
        const path = uid_path();
        await track_upsert(path, 'by-path');

        const ws = await WorkspaceService.get_by_path(path);
        expect(ws.name).toBe('by-path');
    });

    it('throws 404 for unknown path', async () => {
        await expect(WorkspaceService.get_by_path('/nonexistent/path'))
            .rejects.toThrow(/not found/);
    });
});

describe.skipIf(!has_postgres)('WorkspaceService.upsert_by_path', () => {
    it('creates workspace when path is new', async () => {
        const path = uid_path();
        const { record, created } = await track_upsert(path, 'new-ws');

        expect(created).toBe(true);
        expect(record.path).toBe(path);
        expect(record.name).toBe('new-ws');
    });

    it('updates workspace when path already exists', async () => {
        const path = uid_path();
        await track_upsert(path, 'original');

        const { record, created } = await track_upsert(path, 'updated');
        expect(created).toBe(false);
        expect(record.name).toBe('updated');
    });

    it('updates daemon_id on upsert when provided', async () => {
        const path = uid_path();
        const { record } = await track_upsert(path, 'with-daemon', daemon_id);
        expect(record.daemon_id).toBe(daemon_id);
    });

    it('preserves existing name when new name is null', async () => {
        const path = uid_path();
        await track_upsert(path, 'keep-me');

        const { record } = await track_upsert(path);
        expect(record.name).toBe('keep-me');
    });
});

describe.skipIf(!has_postgres)('WorkspaceService.remove', () => {
    it('removes workspace by id', async () => {
        const path = uid_path();
        const { record } = await track_upsert(path);
        await WorkspaceService.remove(record.id);

        await expect(WorkspaceService.get_by_path(path))
            .rejects.toThrow(/not found/);
    });

    it('returns false for unknown id', async () => {
        const result = await WorkspaceService.remove(randomUUID());
        expect(result).toBe(false);
    });
});

describe.skipIf(!has_postgres)('WorkspaceService.add_team / remove_team / list_teams', () => {
    it('adds a team to a workspace', async () => {
        const path = uid_path();
        const { record: ws } = await track_upsert(path);

        const created = await WorkspaceService.add_team(ws.id, team_id);
        expect(created).toBe(true);

        const teams = await WorkspaceService.list_teams(ws.id);
        expect(teams).toHaveLength(1);
        expect(teams[0].team_id).toBe(team_id);
    });

    it('returns false when adding same team twice', async () => {
        const path = uid_path();
        const { record: ws } = await track_upsert(path);

        await WorkspaceService.add_team(ws.id, team_id);
        const second = await WorkspaceService.add_team(ws.id, team_id);
        expect(second).toBe(false);
    });

    it('removes a team from workspace', async () => {
        const path = uid_path();
        const { record: ws } = await track_upsert(path);
        await WorkspaceService.add_team(ws.id, team_id);

        const removed = await WorkspaceService.remove_team(ws.id, team_id);
        expect(removed).toBe(true);

        const teams = await WorkspaceService.list_teams(ws.id);
        expect(teams).toHaveLength(0);
    });

    it('returns false when removing team not in workspace', async () => {
        const path = uid_path();
        const { record: ws } = await track_upsert(path);

        const removed = await WorkspaceService.remove_team(ws.id, randomUUID());
        expect(removed).toBe(false);
    });
});

describe.skipIf(!has_postgres)('WorkspaceService.count_by_team', () => {
    it('returns 0 when team has no workspaces', async () => {
        const count = await WorkspaceService.count_by_team(randomUUID());
        expect(count).toBe(0);
    });

    it('returns correct count', async () => {
        const path_1 = uid_path();
        const path_2 = uid_path();
        const { record: ws1 } = await track_upsert(path_1);
        const { record: ws2 } = await track_upsert(path_2);

        await WorkspaceService.add_team(ws1.id, team_id);
        await WorkspaceService.add_team(ws2.id, team_id);

        const count = await WorkspaceService.count_by_team(team_id);
        expect(count).toBe(2);
    });
});

