/**
 * InvitationsService rules that are decided before anything is written:
 * who may send which invite, and when accept / decline is refused.
 * The flows themselves run over HTTP on Postgres in
 * tests/integration/invitations_flow.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { InvitationsService } from '../../../src/services/invitations_service.js';
import { ALICE, BOB, ORG_ADMIN, SITE_ADMIN, UNAUTHED } from '../../helpers/fixtures.js';

const mocks = vi.hoisted(() => ({
    find_invite_by_token: vi.fn(),
    org_standing: vi.fn(),
    require_permission: vi.fn(),
    user_find_one: vi.fn(),
    transaction: vi.fn(),
}));

vi.mock('../../../src/db/sequelize.js', () => ({
    get_sequelize: () => ({ transaction: mocks.transaction }),
}));
vi.mock('../../../src/services/invite_records.js', async (orig) => ({
    ...(await orig() as object),
    find_invite_by_token: mocks.find_invite_by_token,
}));
vi.mock('../../../src/auth/route_policy/visible.js', () => ({ org_standing: mocks.org_standing }));
vi.mock('../../../src/auth/permissions.js', async (orig) => ({
    ...(await orig() as object),
    require_permission: mocks.require_permission,
}));
vi.mock('../../../src/models/index.js', async (orig) => {
    const real = await orig() as Record<string, unknown>;
    return { ...real, User: { findOne: mocks.user_find_one } };
});

const ORG_ID = hub_legacy_uuid(7);

function make_service() {
    const ns_repo = { find_by_slug: vi.fn().mockResolvedValue(null), find_by_id: vi.fn(), find_by_username: vi.fn().mockResolvedValue(null), find_profile_by_id: vi.fn() };
    const reactivation = { assert_can_reactivate: vi.fn(), restore_user: vi.fn(), restore_org: vi.fn() };
    return new InvitationsService(ns_repo as never, ns_repo as never, ns_repo as never, reactivation as never, vi.fn());
}

function invite(overrides: Record<string, unknown> = {}) {
    return {
        table: 'account_invites', target: 'org', id: 'inv-1', email: 'alice@test.com', role: 'member', status: 'pending',
        invited_by: hub_legacy_uuid(3), created_at: new Date(), expires_at: new Date(Date.now() + 60_000),
        send_count: 1, last_sent_at: null, reminders_sent: 0, org_id: ORG_ID, realm_id: null,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.require_permission.mockResolvedValue(undefined);
    mocks.transaction.mockRejectedValue(new Error('no writes expected in this test'));
});

describe('InvitationsService.create — refused before any write', () => {
    it('needs a signed-in caller', async () => {
        await expect(make_service().create(UNAUTHED as never, { target_type: 'org', org_id: ORG_ID, email: 'x@test.com' }))
            .rejects.toMatchObject({ status: 401 });
    });

    it('owner role on a realm and operator role on an org are 422', async () => {
        await expect(make_service().create(SITE_ADMIN as never, { target_type: 'realm', realm_id: 'r1', email: 'x@test.com', role: 'owner' }))
            .rejects.toMatchObject({ status: 422, code: 'invalid_params' });
        await expect(make_service().create(SITE_ADMIN as never, { target_type: 'org', org_id: ORG_ID, email: 'x@test.com', role: 'operator' }))
            .rejects.toMatchObject({ status: 422, code: 'invalid_params' });
    });

    it('an invalid email is 422', async () => {
        await expect(make_service().create(SITE_ADMIN as never, { target_type: 'org', org_id: ORG_ID, email: 'not-an-email' }))
            .rejects.toMatchObject({ status: 422 });
    });

    it('an org admin who is not an owner cannot invite an owner', async () => {
        mocks.org_standing.mockResolvedValue({ slug: 'admin', is_system: false, permissions: ['org.members.manage'] });
        await expect(make_service().create(ORG_ADMIN as never, { target_type: 'org', org_id: ORG_ID, email: 'x@test.com', role: 'owner' }))
            .rejects.toMatchObject({ status: 403, code: 'forbidden' });
        expect(mocks.org_standing).toHaveBeenCalledWith(ORG_ID, ORG_ADMIN.user!.id);
    });

    it('a caller without org.members.manage is refused by the org check', async () => {
        const { ApiError } = await import('../../../src/errors/api_error.js');
        mocks.require_permission.mockRejectedValue(new ApiError('forbidden', "Permission 'org.members.manage' is required", 403));
        await expect(make_service().create(BOB as never, { target_type: 'org', org_id: ORG_ID, email: 'x@test.com' }))
            .rejects.toMatchObject({ status: 403 });
    });
});

describe('InvitationsService.accept — refused before any write', () => {
    const accept = (auth: unknown, body: Record<string, unknown>) =>
        make_service().accept(auth as never, { token: 'tok', decision: 'accept', ...body } as never);

    it('unknown token → 404', async () => {
        mocks.find_invite_by_token.mockResolvedValue(null);
        await expect(accept(UNAUTHED, {})).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });

    it('past its expiry → 410 expired with expired_at', async () => {
        const expires_at = new Date(Date.now() - 1000);
        mocks.find_invite_by_token.mockResolvedValue(invite({ expires_at }));
        await expect(accept(UNAUTHED, {})).rejects.toMatchObject({ status: 410, code: 'expired', details: { expired_at: expires_at.toISOString() } });
        await expect(accept(UNAUTHED, { decision: 'decline' })).rejects.toMatchObject({ status: 410 });
    });

    it('used or revoked → 409 not_pending with the status', async () => {
        for (const status of ['accepted', 'declined', 'revoked'] as const) {
            mocks.find_invite_by_token.mockResolvedValue(invite({ status }));
            await expect(accept(UNAUTHED, {})).rejects.toMatchObject({ status: 409, code: 'not_pending', details: { status } });
        }
    });

    it('signed in as another email → 403 email_mismatch with the invitee email', async () => {
        mocks.find_invite_by_token.mockResolvedValue(invite({ email: 'someone@test.com' }));
        await expect(accept(ALICE, {})).rejects.toMatchObject({ status: 403, code: 'email_mismatch', details: { invitee_email: 'someone@test.com' } });
    });

    it('an existing account that is not signed in → 401 sign_in_required', async () => {
        mocks.find_invite_by_token.mockResolvedValue(invite());
        mocks.user_find_one.mockResolvedValue({ id: hub_legacy_uuid(1), status: 'active', deleted_at: null });
        await expect(accept(UNAUTHED, { username: 'alice2', password: 'password123' }))
            .rejects.toMatchObject({ status: 401, code: 'sign_in_required', details: { invitee_email: 'alice@test.com' } });
    });

    it('a deleted account → 403 account_deleted', async () => {
        mocks.find_invite_by_token.mockResolvedValue(invite());
        mocks.user_find_one.mockResolvedValue({ id: hub_legacy_uuid(1), status: 'active', deleted_at: new Date() });
        await expect(accept(UNAUTHED, {})).rejects.toMatchObject({ status: 403, code: 'account_deleted' });
    });

    it('a new person must send a valid username and password', async () => {
        mocks.find_invite_by_token.mockResolvedValue(invite());
        mocks.user_find_one.mockResolvedValue({ id: hub_legacy_uuid(8), status: 'invited', deleted_at: null });
        await expect(accept(UNAUTHED, { password: 'password123' })).rejects.toMatchObject({ status: 422, details: { field: 'username' } });
        await expect(accept(UNAUTHED, { username: 'newbie', password: 'short' })).rejects.toMatchObject({ status: 422, details: { field: 'password' } });
        await expect(accept(UNAUTHED, { username: '1bad', password: 'password123' })).rejects.toMatchObject({ status: 422, details: { field: 'username' } });
        expect(mocks.transaction).not.toHaveBeenCalled();
    });
});
