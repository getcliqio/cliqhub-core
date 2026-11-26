/**
 * RunController.get — each run row says who started it (`started_by`, Core API 8).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../../../src/services/run.service.js', () => ({
    RunService: { list_recent: vi.fn() },
}));
vi.mock('../../../src/services/realm.service.js', () => ({
    RealmService: { slugs_by_ids: vi.fn().mockResolvedValue(new Map()) },
}));
vi.mock('../../../src/services/user_refs.service.js', () => ({
    UserRefs: {
        by_ids: vi.fn().mockResolvedValue(new Map([['u-sapan', { id: 'u-sapan', username: 'sapan', display_name: 'Sapan Shah' }]])),
        pick: (refs: Map<string, unknown>, id: string | null | undefined) => (id ? refs.get(id) ?? null : null),
    },
}));

import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { AuthContext } from '../../../src/schemas/auth_types.js';
import { RunController } from '../../../src/controllers/runs_controller.js';
import { RunService } from '../../../src/services/run.service.js';
import { UserRefs } from '../../../src/services/user_refs.service.js';

const REALM = hub_legacy_uuid(30);
const auth: AuthContext = { user: { id: hub_legacy_uuid(1), username: 'alice', role: 'user' } as AuthContext['user'], org_slugs: [], org_ids: [], scopes: [], auth_via: 'pat' };

function mock_res() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

describe('RunController.get started_by', () => {
    beforeEach(() => vi.clearAllMocks());

    it('fills each row from its started_by user id, in one user read; unknown → null', async () => {
        vi.mocked(RunService.list_recent).mockResolvedValue({
            runs: [
                { run_id: 'r1', realm_id: REALM, started_at: 1, state: 'completed', started_by: 'u-sapan' },
                { run_id: 'r2', realm_id: REALM, started_at: 2, state: 'running', started_by: null },
            ],
            total: 2,
        } as never);
        const res = mock_res();
        await new RunController().get({ body: { realm_id: REALM, limit: 10 }, auth } as unknown as Request as never, res as never);
        expect(UserRefs.by_ids).toHaveBeenCalledTimes(1);
        expect(UserRefs.by_ids).toHaveBeenCalledWith(['u-sapan', null]);
        const items = (vi.mocked(res.json).mock.calls[0][0] as { data: { items: Array<{ run_id: string; started_by: unknown }> } }).data.items;
        expect(items.map((r) => [r.run_id, r.started_by])).toEqual([
            ['r1', { id: 'u-sapan', username: 'sapan', display_name: 'Sapan Shah' }],
            ['r2', null],
        ]);
    });
});
