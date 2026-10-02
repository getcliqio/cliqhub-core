/**
 * Invite rules: roles per target, invite kinds, status at a given time,
 * reminder timing and list sorting.
 */
import { describe, it, expect } from 'vitest';

import {
    assert_role_for_target, effective_status, invite_kind, org_member_role_column, parse_invite_sort, reminder_due,
} from '../../../src/services/invite_rules.js';
import { INVITE_REMINDER_OFFSETS_MS, INVITE_TTL_MS } from '../../../src/config/identity_lifecycle.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-02T10:00:00Z');
const at = (ms_from_now: number) => new Date(NOW.getTime() + ms_from_now);

describe('assert_role_for_target', () => {
    it('owner is for orgs only, operator for realms only', () => {
        expect(() => assert_role_for_target('org', 'owner')).not.toThrow();
        expect(() => assert_role_for_target('realm', 'operator')).not.toThrow();
        expect(() => assert_role_for_target('realm', 'owner')).toThrow(expect.objectContaining({ status: 422, code: 'invalid_params' }));
        expect(() => assert_role_for_target('org', 'operator')).toThrow(expect.objectContaining({ status: 422, code: 'invalid_params' }));
        for (const role of ['admin', 'member'] as const) {
            expect(() => assert_role_for_target('org', role)).not.toThrow();
            expect(() => assert_role_for_target('realm', role)).not.toThrow();
        }
    });
});

describe('invite_kind / org_member_role_column', () => {
    it('realm invites are realm; org invites are owner or org by role', () => {
        expect(invite_kind('realm', 'admin')).toBe('realm');
        expect(invite_kind('org', 'owner')).toBe('owner');
        expect(invite_kind('org', 'admin')).toBe('org');
        expect(invite_kind('org', 'member')).toBe('org');
    });

    it('owners and admins are stored as legacy admin; members as member', () => {
        expect(org_member_role_column('owner')).toBe('admin');
        expect(org_member_role_column('admin')).toBe('admin');
        expect(org_member_role_column('member')).toBe('member');
    });
});

describe('effective_status', () => {
    it('a pending invite past its expiry is expired; other states are kept', () => {
        expect(effective_status({ status: 'pending', expires_at: at(1000) }, NOW)).toBe('pending');
        expect(effective_status({ status: 'pending', expires_at: at(0) }, NOW)).toBe('expired');
        expect(effective_status({ status: 'pending', expires_at: at(-1).toISOString() }, NOW)).toBe('expired');
        expect(effective_status({ status: 'accepted', expires_at: at(-DAY) }, NOW)).toBe('accepted');
        expect(effective_status({ status: 'revoked', expires_at: at(DAY) }, NOW)).toBe('revoked');
    });
});

describe('reminder_due', () => {
    it('uses the configured offsets: 3 days and 1 day before expiry', () => {
        expect(INVITE_REMINDER_OFFSETS_MS).toEqual([3 * DAY, 1 * DAY]);
        expect(INVITE_TTL_MS).toBe(14 * DAY);
    });

    it('nothing is due more than 3 days before expiry', () => {
        expect(reminder_due({ expires_at: at(3 * DAY + 1), reminders_sent: 0 }, NOW)).toBeNull();
    });

    it('the first reminder is due at 3 days, once', () => {
        expect(reminder_due({ expires_at: at(3 * DAY), reminders_sent: 0 }, NOW)).toEqual({ reminders_sent: 1 });
        expect(reminder_due({ expires_at: at(2 * DAY), reminders_sent: 1 }, NOW)).toBeNull();
    });

    it('the second reminder is due at 1 day, once', () => {
        expect(reminder_due({ expires_at: at(DAY), reminders_sent: 1 }, NOW)).toEqual({ reminders_sent: 2 });
        expect(reminder_due({ expires_at: at(DAY / 2), reminders_sent: 2 }, NOW)).toBeNull();
    });

    it('when both are due (sweep was down) one reminder goes out and the counter skips both', () => {
        expect(reminder_due({ expires_at: at(DAY / 2), reminders_sent: 0 }, NOW)).toEqual({ reminders_sent: 2 });
    });

    it('an expired invite gets no reminder', () => {
        expect(reminder_due({ expires_at: at(0), reminders_sent: 0 }, NOW)).toBeNull();
        expect(reminder_due({ expires_at: at(-DAY), reminders_sent: 1 }, NOW)).toBeNull();
    });
});

describe('parse_invite_sort', () => {
    it('defaults to newest first', () => {
        expect(parse_invite_sort(undefined)).toEqual({ field: 'created_at', dir: 'DESC' });
    });

    it('reads a field with an optional - for descending', () => {
        expect(parse_invite_sort('email')).toEqual({ field: 'email', dir: 'ASC' });
        expect(parse_invite_sort('-expires_at')).toEqual({ field: 'expires_at', dir: 'DESC' });
    });

    it('rejects unknown fields with 422', () => {
        expect(() => parse_invite_sort('token_hash')).toThrow(expect.objectContaining({ status: 422 }));
        expect(() => parse_invite_sort('-')).toThrow(expect.objectContaining({ status: 422 }));
    });
});
