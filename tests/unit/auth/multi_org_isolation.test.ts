/**
 * Multi-org isolation — cross-tenant access deny scenarios.
 *
 * Verifies that a user authenticated to org A cannot perform operations on
 * org B's resources. Tests call controller/service methods directly so errors
 * propagate as thrown exceptions.
 *
 * Principals:
 *   Alice  — member of ACME_ORG only
 *   Bob    — member of BETA_ORG only
 *   Admin  — site admin, no org memberships
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request, Response } from 'express';

// ---- Hoisted mocks ----

vi.mock('../../../src/auth/permissions.js', async (importOriginal) => ({
    ...(await importOriginal() as Record<string, unknown>),
    require_permission: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/models/index.js', async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
        ...actual,
        Realm: { findByPk: vi.fn().mockResolvedValue(null) },
    };
});

vi.mock('../../../src/db/sequelize.js', () => ({
    get_sequelize: vi.fn().mockReturnValue({
        transaction: vi.fn().mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn({})),
        query: vi.fn().mockResolvedValue([[], {}]),
    }),
}));

vi.mock('../../../src/services/realm.service.js', () => ({
    RealmService: {
        list_realm_ids_for_user_in_org: vi.fn().mockResolvedValue([]),
        assert_member: vi.fn().mockRejectedValue(Object.assign(new Error('not a realm member'), { status: 403 })),
        require_admin: vi.fn().mockRejectedValue(Object.assign(new Error('not realm admin'), { status: 403 })),
    },
}));

// ---- Constants ----

const ACME_ORG_ID = hub_legacy_uuid(1);
const BETA_ORG_ID = hub_legacy_uuid(2);
const ALICE_ID    = hub_legacy_uuid(10);
const BOB_ID      = hub_legacy_uuid(11);
const ADMIN_ID    = hub_legacy_uuid(99);

import type { AuthContext } from '../../../src/schemas/auth_types.js';

function pat_auth(user_id: string, org_ids: string[], role: 'user' | 'admin' = 'user'): AuthContext {
    return {
        user: { id: user_id, username: 'user', role, display_name: '', email: '', suspended_at: null, suspended_reason: '', created_at: '' },
        org_ids,
        org_slugs: org_ids.map(() => 'myorg'),
        scopes: [],
        auth_via: 'pat',
    };
}

const ALICE_AUTH = pat_auth(ALICE_ID, [ACME_ORG_ID]);   // member of ACME only
const BOB_AUTH   = pat_auth(BOB_ID,   [BETA_ORG_ID]);   // member of BETA only
const ADMIN_AUTH = pat_auth(ADMIN_ID, [], 'admin');      // site admin, no orgs

function make_req(body: Record<string, unknown>, auth: AuthContext): Request {
    return { body, auth } as unknown as Request;
}

function make_res(): Response {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

// ---- AgentsController — cross-org via BaseController.assert_org_authorized ----

import { AgentsController } from '../../../src/controllers/agents_controller.js';
import { org_role_store, policy_status } from '../../helpers/policy_decision.js';

const mock_agent_service = {
    list: vi.fn().mockResolvedValue([]),
    get_by_name: vi.fn().mockResolvedValue(null),
    get_by_catalog_id: vi.fn().mockResolvedValue(null),
    register: vi.fn().mockResolvedValue({ entry: {}, updated: false }),
    deregister: vi.fn().mockResolvedValue(true),
    list_settings_summary: vi.fn().mockResolvedValue([]),
    get_settings: vi.fn().mockResolvedValue({ name: 'x', settings: {}, values: {} }),
    update_settings: vi.fn().mockResolvedValue(true),
};

describe('multi-org isolation', () => {
    beforeEach(() => vi.clearAllMocks());

    // ------------------------------------------------------------------ agents
    describe('AgentsController — BaseController.assert_org_authorized', () => {
        let controller: AgentsController;

        beforeEach(() => {
            controller = new AgentsController(mock_agent_service as never, {
                permission_check: async () => false,
            });
        });

        it('get: 422 when org_id is absent', async () => {
            // parse_body throws legacy ApiError with .status property
            await expect(
                controller.get(make_req({}, ALICE_AUTH) as never, make_res() as never),
            ).rejects.toMatchObject({ status: 422 });
        });

        it('get: succeeds when user is a member of the requested org', async () => {
            const controller_with_allow = new AgentsController(mock_agent_service as never, {
                permission_check: async () => true,
            });
            const res = make_res();
            await controller_with_allow.get(make_req({ org_id: ACME_ORG_ID }, ALICE_AUTH) as never, res as never);
            expect(res.status).toHaveBeenCalledWith(200);
        });

        it('site admin can get agents from any org without being a member', async () => {
            const admin_controller = new AgentsController(mock_agent_service as never, {
                permission_check: async () => true,
            });
            const res = make_res();
            await admin_controller.get(
                make_req({ org_id: BETA_ORG_ID }, ADMIN_AUTH) as never,
                res as never,
            );
            expect(res.status).toHaveBeenCalledWith(200);
        });
    });

    // ------------------------------------------------------------------ service-level org check
    describe('route policy — org membership (moved out of controllers and services)', () => {
        // Alice: ACME member (plain role); Bob: BETA member; site admin in neither.
        const store = org_role_store({ [ACME_ORG_ID]: { [ALICE_ID]: 'member' }, [BETA_ORG_ID]: { [BOB_ID]: 'member' } });
        const st = (route: string, id: string, body: Record<string, unknown>, role: 'user' | 'admin' = 'user') =>
            policy_status(route, { id, role }, body, store);

        it('Alice cannot reach BETA, Bob cannot reach ACME (agents, orgs, runs) — 404', async () => {
            for (const route of ['POST /v1/agents/get', 'POST /v1/orgs/list_roles', 'POST /v1/runs/get', 'POST /v1/orgs/update']) {
                expect(await st(route, ALICE_ID, { org_id: BETA_ORG_ID }), route).toBe(404);
                expect(await st(route, BOB_ID, { org_id: ACME_ORG_ID }), route).toBe(404);
            }
        });

        it('a member without the permission gets 403 (register needs agents.manage)', async () => {
            expect(await st('POST /v1/agents/register', ALICE_ID, { org_id: ACME_ORG_ID })).toBe(403);
            expect(await st('POST /v1/orgs/update', ALICE_ID, { org_id: ACME_ORG_ID })).toBe(403);
        });

        it('members pass member-level routes; site admin passes everywhere', async () => {
            expect(await st('POST /v1/orgs/list_roles', ALICE_ID, { org_id: ACME_ORG_ID })).toBe(200);
            for (const org_id of [ACME_ORG_ID, BETA_ORG_ID]) {
                expect(await st('POST /v1/agents/register', ADMIN_ID, { org_id }, 'admin')).toBe(200);
            }
        });
    });

    // ------------------------------------------------------------------ cross-principal symmetry
    describe('cross-principal symmetry', () => {
        it('admin can access both ACME and BETA (agents)', async () => {
            const controller = new AgentsController(mock_agent_service as never, {
                permission_check: async () => true,
            });
            for (const org_id of [ACME_ORG_ID, BETA_ORG_ID]) {
                const res = make_res();
                await controller.get(make_req({ org_id }, ADMIN_AUTH) as never, res as never);
                expect(res.status).toHaveBeenCalledWith(200);
            }
        });
    });
});
