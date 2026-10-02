import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';

setup_sequelize_mocks();

import { PasswordReset, PasswordResetRequest } from '../../../src/models/index.js';
import {
    PasswordLinkService, forgot_password_limited, password_link_state, password_link_ttl_ms,
} from '../../../src/services/password_link.service.js';
import { FORGOT_PASSWORD_LIMITS, RESET_LINK_TTL_MS, SETUP_LINK_TTL_MS } from '../../../src/config/identity_lifecycle.js';
import { hash_token } from '../../../src/lib/secure_token.js';
import { use_test_link_env } from '../../helpers/link_env.js';

const now = new Date('2026-10-02T10:00:00Z');
const t = { LOCK: { UPDATE: 'UPDATE' } } as never;

describe('password link rules', () => {
    it('setup links last 7 days, reset links 24 hours', () => {
        expect(password_link_ttl_ms('setup')).toBe(SETUP_LINK_TTL_MS);
        expect(password_link_ttl_ms('reset')).toBe(RESET_LINK_TTL_MS);
        expect(SETUP_LINK_TTL_MS).toBe(7 * 24 * 3600_000);
        expect(RESET_LINK_TTL_MS).toBe(24 * 3600_000);
    });

    it('state: used wins over expired; expired at the expiry instant', () => {
        expect(password_link_state({ used_at: null, expires_at: new Date(now.getTime() + 1) }, now)).toBe('open');
        expect(password_link_state({ used_at: null, expires_at: now }, now)).toBe('expired');
        expect(password_link_state({ used_at: new Date(0), expires_at: new Date(0) }, now)).toBe('used');
    });

    it('forgot password: 3 per email per window, and nothing per address', () => {
        expect(FORGOT_PASSWORD_LIMITS).toEqual({ window_ms: 3600_000, per_email: 3 });
        expect(forgot_password_limited(2)).toBe(false);
        expect(forgot_password_limited(3)).toBe(true);
    });
});

describe('PasswordLinkService', () => {
    const svc = new PasswordLinkService();
    let restore_env: () => void;

    beforeAll(() => {
        restore_env = use_test_link_env();
        (PasswordReset as unknown as { sequelize: { query: unknown } }).sequelize.query = vi.fn().mockResolvedValue([[], {}]);
    });
    afterAll(() => { restore_env(); });
    beforeEach(() => { vi.clearAllMocks(); });

    it('issue: a new link stores the token hash and an encrypted copy, never the token', async () => {
        vi.mocked(PasswordReset.findOne).mockResolvedValueOnce(null);
        vi.mocked(PasswordReset.create).mockResolvedValueOnce({ id: 'r1' } as never);

        const out = await svc.issue('u1', 'setup', { requested_by: 'admin', transaction: t, now });

        expect(out).toEqual({ id: 'r1', expires_at: new Date(now.getTime() + SETUP_LINK_TTL_MS), send_count: 1, resent: false });
        const row = vi.mocked(PasswordReset.create).mock.calls[0][0] as unknown as Record<string, unknown>;
        expect(row).toMatchObject({ user_id: 'u1', purpose: 'setup', send_count: 1, requested_by: 'admin' });
        expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.token_enc).toMatch(/^v1\./);
        expect(Object.keys(row)).not.toContain('token');
    });

    it('issue: an open link is sent again — same row and token, new expiry, send_count + 1', async () => {
        const open = { id: 'r1', token_hash: 'h', token_enc: 'e', send_count: 2, expires_at: new Date(0), last_sent_at: new Date(0), requested_by: null, save: vi.fn() };
        vi.mocked(PasswordReset.findOne).mockResolvedValueOnce(open as never);

        const out = await svc.issue('u1', 'reset', { requested_by: null, transaction: t, now });

        expect(out).toEqual({ id: 'r1', expires_at: new Date(now.getTime() + RESET_LINK_TTL_MS), send_count: 3, resent: true });
        expect(open).toMatchObject({ token_hash: 'h', token_enc: 'e', last_sent_at: now });
        expect(open.save).toHaveBeenCalled();
        expect(PasswordReset.create).not.toHaveBeenCalled();
        expect(vi.mocked(PasswordReset.findOne).mock.calls[0][0]).toMatchObject({ where: { user_id: 'u1', purpose: 'reset' }, lock: 'UPDATE' });
        expect(PasswordReset.sequelize!.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), expect.objectContaining({ replacements: { key: 'password_link:u1:reset' } }));
    });

    it('redeem: looks the token up by hash and marks it used', async () => {
        const row = { used_at: null, expires_at: new Date(now.getTime() + 60_000), save: vi.fn() };
        vi.mocked(PasswordReset.findOne).mockResolvedValueOnce(row as never);
        await expect(svc.redeem('tok', t, now)).resolves.toBe(row);
        expect(vi.mocked(PasswordReset.findOne).mock.calls[0][0]).toMatchObject({ where: { token_hash: hash_token('tok') } });
        expect(row.used_at).toBe(now);
    });

    it('redeem: unknown → 404, used → 409 not_pending, expired → 410 expired', async () => {
        await expect(svc.redeem('tok', t, now)).rejects.toMatchObject({ status: 404, code: 'not_found' });

        vi.mocked(PasswordReset.findOne).mockResolvedValueOnce({ used_at: new Date(0), expires_at: new Date(now.getTime() + 1) } as never);
        await expect(svc.redeem('tok', t, now)).rejects.toMatchObject({ status: 409, code: 'not_pending', details: { status: 'used' } });

        const expires_at = new Date(now.getTime() - 1);
        vi.mocked(PasswordReset.findOne).mockResolvedValueOnce({ used_at: null, expires_at } as never);
        await expect(svc.redeem('tok', t, now)).rejects.toMatchObject({ status: 410, code: 'expired', details: { expired_at: expires_at.toISOString() } });
    });

    it('record_forgot_request: under the limit it records the request, counted under a lock on the email', async () => {
        vi.mocked(PasswordResetRequest.count).mockResolvedValueOnce(2);
        await svc.record_forgot_request('a@b.c', now);
        expect(PasswordResetRequest.create).toHaveBeenCalledWith({ email: 'a@b.c', created_at: now }, expect.anything());
        const keys = vi.mocked(PasswordResetRequest.sequelize!.query).mock.calls.map((c) => (c[1] as { replacements: { key: string } }).replacements.key);
        expect(keys).toEqual(['forgot_password:email:a@b.c']);
    });

    it('record_forgot_request: over the limit → 429 and nothing recorded', async () => {
        vi.mocked(PasswordResetRequest.count).mockResolvedValueOnce(3);
        await expect(svc.record_forgot_request('a@b.c', now)).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
        expect(PasswordResetRequest.create).not.toHaveBeenCalled();
    });
});
