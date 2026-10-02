import { describe, expect, it } from 'vitest';

import { ApiError, status_for_code } from '../../../src/errors/api_error.js';

describe('contract error codes', () => {
    it.each([
        ['conflict', 409], ['deleted', 409], ['locked', 409], ['already_member', 409],
        ['not_pending', 409], ['owns_orgs', 409], ['not_active', 409], ['expired', 410],
        ['sign_in_required', 401], ['email_mismatch', 403], ['account_deleted', 403], ['rate_limited', 429],
    ])('%s → %i', (code, status) => {
        expect(status_for_code(code)).toBe(status);
        expect(new ApiError(code, 'x').status).toBe(status);
    });

    it('helpers carry their details', () => {
        const deleted = { kind: 'org' as const, id: 'o1', deleted_at: '2026-10-02T11:00:00.000Z', was_active: true };
        expect(ApiError.deleted('acme belongs to a deleted org', deleted)).toMatchObject({ status: 409, code: 'deleted', details: deleted });
        expect(ApiError.name_conflict('taken', { kind: 'user', field: 'email', holder: { id: 'u1', slug: 'priya' } }))
            .toMatchObject({ status: 409, code: 'conflict', details: { kind: 'user', field: 'email', holder: { id: 'u1', slug: 'priya' } } });
        expect(ApiError.locked('invite.sent.invitee')).toMatchObject({ status: 409, code: 'locked', details: { system_key: 'invite.sent.invitee' } });
        expect(ApiError.already_member('u1')).toMatchObject({ status: 409, code: 'already_member', details: { user_id: 'u1' } });
        expect(ApiError.not_pending('revoked')).toMatchObject({ status: 409, code: 'not_pending', details: { status: 'revoked' } });
        expect(ApiError.owns_orgs([{ slug: 'measureone' }])).toMatchObject({
            status: 409, code: 'owns_orgs', message: 'Transfer or delete these orgs first.', details: { orgs: [{ slug: 'measureone' }] },
        });
        expect(ApiError.not_active('suspended')).toMatchObject({ status: 409, code: 'not_active', details: { status: 'suspended' } });
        expect(ApiError.expired('2026-10-16T10:20:00.000Z')).toMatchObject({ status: 410, code: 'expired', details: { expired_at: '2026-10-16T10:20:00.000Z' } });
        expect(ApiError.sign_in_required('p@x.test')).toMatchObject({ status: 401, code: 'sign_in_required', details: { invitee_email: 'p@x.test' } });
        expect(ApiError.email_mismatch('p@x.test')).toMatchObject({ status: 403, code: 'email_mismatch', details: { invitee_email: 'p@x.test' } });
        expect(ApiError.account_deleted()).toMatchObject({ status: 403, code: 'account_deleted', message: 'This account was deleted. Contact your admin.' });
        expect(ApiError.account_deleted().details).toBeUndefined();
        expect(ApiError.rate_limited()).toMatchObject({ status: 429, code: 'rate_limited' });
    });
});
