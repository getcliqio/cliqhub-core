/**
 * RunController.create — who started a daemon-pushed run (`started_by`).
 * A daemon reporting a CLI run passes the sender it validated (`started_by_user_id`); it is used only
 * when the caller is a daemon token and the sender can operate the run's realm.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../../../src/services/run.service.js', () => ({
    RunService: { create: vi.fn().mockResolvedValue('run-1') },
}));
vi.mock('../../../src/services/realm.service.js', () => ({
    RealmService: { assert_daemon_in_realm: vi.fn().mockResolvedValue(undefined), list_realms_for_daemon: vi.fn() },
}));
vi.mock('../../../src/auth/route_policy/visible.js', () => ({
    visible_realm_ids: vi.fn(),
}));

import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { AuthContext } from '../../../src/schemas/auth_types.js';
import { RunController } from '../../../src/controllers/runs_controller.js';
import { RunService } from '../../../src/services/run.service.js';
import { visible_realm_ids } from '../../../src/auth/route_policy/visible.js';

const REALM = hub_legacy_uuid(30);
const OWNER = hub_legacy_uuid(1);
const SENDER = hub_legacy_uuid(2);
const daemon_auth = { user: { id: OWNER, username: 'owner', role: 'user' }, org_slugs: [], org_ids: [], scopes: [], auth_via: 'daemon_token', realm_id: REALM } as unknown as AuthContext;
const pat_auth = { user: { id: OWNER, username: 'owner', role: 'user' }, org_slugs: [], org_ids: [], scopes: [], auth_via: 'pat' } as unknown as AuthContext;

const body = (extra: Record<string, unknown> = {}) => ({
    run_id: hub_legacy_uuid(40), workspace_id: hub_legacy_uuid(41), workspace_path: '/w', team_id: hub_legacy_uuid(42), daemon_id: hub_legacy_uuid(43), execution_type: 'local', origin: 'cli', ...extra,
});

function mock_res() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

async function create(auth: AuthContext, b: Record<string, unknown>) {
    await new RunController().create({ body: b, auth } as unknown as Request as never, mock_res() as never);
    return (vi.mocked(RunService.create).mock.calls[0][2] as { started_by: string | null }).started_by;
}

describe('RunController.create started_by', () => {
    beforeEach(() => vi.clearAllMocks());

    it('no sender: the token owner, as before', async () => {
        expect(await create(daemon_auth, body())).toBe(OWNER);
        expect(visible_realm_ids).not.toHaveBeenCalled();
    });

    it('a daemon token with a sender who can operate the realm: the sender', async () => {
        vi.mocked(visible_realm_ids).mockResolvedValue([REALM]);
        expect(await create(daemon_auth, body({ started_by_user_id: SENDER }))).toBe(SENDER);
        expect(visible_realm_ids).toHaveBeenCalledWith(SENDER, { need: 'operate' });
    });

    it('a sender outside the realm is ignored: the token owner', async () => {
        vi.mocked(visible_realm_ids).mockResolvedValue([hub_legacy_uuid(31)]);
        expect(await create(daemon_auth, body({ started_by_user_id: SENDER }))).toBe(OWNER);
    });

    it('only a daemon token may name a sender: a user token keeps its own user', async () => {
        const { RealmService } = await import('../../../src/services/realm.service.js');
        vi.mocked(RealmService.list_realms_for_daemon).mockResolvedValue([{ id: REALM }] as never);
        vi.mocked(visible_realm_ids).mockResolvedValue([REALM]);
        expect(await create(pat_auth, body({ started_by_user_id: SENDER }))).toBe(OWNER);
        expect(visible_realm_ids).not.toHaveBeenCalledWith(SENDER, expect.anything());
    });
});
