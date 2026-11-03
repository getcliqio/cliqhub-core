/**
 * Live teams / workspaces from a daemon (`daemon_live_inventory.service.ts`)
 * on the `data` cliqd answers — taken from the shared wire fixture
 * `tests/fixtures/daemon_wire/daemon_replies.json` (copy of the daemon's;
 * keep in sync). `query_daemon` itself is covered in
 * `tests/unit/dispatch.service.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/dispatch.service.js', () => ({
    DispatchService: { query_daemon: vi.fn() },
}));
vi.mock('../../../src/services/workspace.service.js', () => ({
    WorkspaceService: { mirror_from_daemon: vi.fn(async () => undefined) },
}));
vi.mock('../../../src/repositories/workspace_repository.js', () => ({
    WorkspaceRepository: class { find_all = vi.fn(async () => []); },
}));
vi.mock('../../../src/lib/log.js', () => ({
    get_logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { DispatchService } from '../../../src/services/dispatch.service.js';
import { WorkspaceService } from '../../../src/services/workspace.service.js';
import { live_teams_from_daemon, live_workspaces_from_daemon } from '../../../src/services/daemon_live_inventory.service.js';

/** The `data` of a pinned success reply. */
function pinned_data(name: 'teams_get' | 'workspaces_get'): Record<string, Array<Record<string, unknown>>> {
    const wire = JSON.parse(readFileSync(
        fileURLToPath(new URL('../../fixtures/daemon_wire/daemon_replies.json', import.meta.url)),
        'utf8',
    )) as { query: Record<string, { body: { data: Record<string, Array<Record<string, unknown>>> } }> };
    return wire.query[name]!.body.data;
}

beforeEach(() => vi.clearAllMocks());

describe('live_teams_from_daemon', () => {
    it('asks teams/get with {} and answers it as is: a read, Core records nothing from it (PLAN-team-bundle S4.2)', async () => {
        const data = pinned_data('teams_get');
        vi.mocked(DispatchService.query_daemon).mockResolvedValueOnce(data);
        expect(await live_teams_from_daemon('daemon-1', 'user-1')).toBe(data);
        expect(DispatchService.query_daemon).toHaveBeenCalledWith('daemon-1', '/v1/teams/get', {}, 'user-1');
    });
});

describe('live_workspaces_from_daemon', () => {
    it('asks workspaces/get with {} and mirrors data.workspaces[]', async () => {
        const data = pinned_data('workspaces_get');
        vi.mocked(DispatchService.query_daemon).mockResolvedValueOnce(data);
        expect(await live_workspaces_from_daemon('daemon-1', 'user-1')).toBe(data);
        const ws = data.workspaces![0]!;
        expect(WorkspaceService.mirror_from_daemon).toHaveBeenCalledWith(expect.objectContaining({
            id: ws.workspace_id, path: ws.workspace_dir, daemon_id: 'daemon-1',
        }));
    });
});
