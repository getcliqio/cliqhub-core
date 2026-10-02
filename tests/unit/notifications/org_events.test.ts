import { describe, expect, it } from 'vitest';

import { EVENT_TYPES, EVENT_TYPE_SEVERITY, event_submit_schema, is_system_event_type } from '../../../src/schemas/event_types.js';
import { EVENT_GROUP_TYPES, expand_event_selector } from '../../../src/notifications/types.js';
import {
    INVITE_KINDS,
    ORG_ABANDONED,
    USER_PASSWORD_CHANGED,
    USER_PASSWORD_RESET_SENT,
    USER_SETUP_SENT,
    describe_org_event,
    invite_event,
    type InviteEventData,
} from '../../../src/notifications/org_events.js';
import { is_recipient_selector } from '../../../src/notifications/recipients.js';
import { default_rule_specs } from '../../../src/services/org_seed.service.js';

const invite_data: InviteEventData = {
    invite_id: 'inv-1', kind: 'org', role: 'member', invitee_email: 'priya@measureone.test',
    inviter: { id: 'u-1', display_name: 'Sapan Shah' },
    org: { slug: 'measureone', display_name: 'MeasureOne' }, realm: null,
    expires_at: '2026-10-16T10:20:00.000Z', send_count: 1,
};

describe('org event catalogue', () => {
    it('has every org event in the catalogue with a severity', () => {
        const expected = [
            ...INVITE_KINDS.flatMap((k) => (['sent', 'reminder', 'accepted', 'declined', 'expired', 'revoked'] as const).map((a) => `invite.${k}.${a}`)),
            ORG_ABANDONED, USER_SETUP_SENT, USER_PASSWORD_RESET_SENT, USER_PASSWORD_CHANGED,
        ];
        expect(expected).toHaveLength(22);
        for (const type of expected) {
            expect(EVENT_TYPES).toContain(type);
            expect(EVENT_TYPE_SEVERITY[type as keyof typeof EVENT_TYPE_SEVERITY]).toBeTruthy();
        }
        expect(invite_event('realm', 'reminder')).toBe('invite.realm.reminder');
    });

    it('rule selectors can target the new families', () => {
        expect(EVENT_GROUP_TYPES['invite.*']).toHaveLength(18);
        expect(expand_event_selector('user')).toEqual(['user.setup.sent', 'user.password_reset.sent', 'user.password.changed']);
        expect(expand_event_selector('org.*')).toEqual(['org.abandoned']);
    });

    it('clients cannot submit system events', () => {
        expect(is_system_event_type('invite.org.sent')).toBe(true);
        expect(is_system_event_type('run.failed')).toBe(false);
        const parsed = event_submit_schema.safeParse({ type: 'invite.org.sent', org_id: 'o1', payload: { data: invite_data } });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0].message).toContain('raised by CliqHub only');
    });

    it('describes events for in-app and chat without links', () => {
        expect(describe_org_event('invite.org.accepted', invite_data)).toEqual({
            title: 'Invite accepted', message: 'priya@measureone.test accepted the invite to MeasureOne',
        });
        const realm = describe_org_event('invite.realm.sent', { ...invite_data, kind: 'realm', realm: { slug: 'ops', display_name: 'Ops' } });
        expect(realm.message).toBe('Sapan Shah invited priya@measureone.test to Ops (MeasureOne)');
        const user = { id: 'u-2', username: 'priya', email: 'priya@measureone.test', display_name: 'Priya N' };
        expect(describe_org_event(USER_PASSWORD_CHANGED, { user, sessions_revoked: 2 }).title).toBe('Password changed');
        expect(describe_org_event(ORG_ABANDONED, {
            org: { id: 'o', slug: 'm', display_name: 'M' }, invite_id: 'i', invitee_email: 'x@y.test',
            inviter: { id: 'u', display_name: 'S' }, expired_at: '2026-10-16T10:20:00.000Z',
        }).message).toContain('never accepted the owner invite');
    });

    it('recipient selectors are the named ones or user ids', () => {
        for (const s of ['invitee', 'org_owners', 'inviter', 'user', '8f2b4c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f']) expect(is_recipient_selector(s)).toBe(true);
        expect(is_recipient_selector('everyone')).toBe(false);
    });
});

describe('default rules (contract events table)', () => {
    it('org rules: sent/reminder locked to the invitee by Email with an editable In-app copy; accepted/declined/expired editable to owners + inviter on Email and In-app; abandoned to the inviter in-app; revoked none', () => {
        const rules = default_rule_specs(false);
        const by = (event: string) => rules.filter((r) => r.event === event);
        for (const kind of INVITE_KINDS) {
            for (const action of ['sent', 'reminder'] as const) {
                expect(by(invite_event(kind, action))).toEqual([
                    expect.objectContaining({ channel: 'org.email', recipients: ['invitee'], lock_reason: expect.any(String), version: 1 }),
                    expect.objectContaining({ channel: 'org.in_app', recipients: ['invitee'], lock_reason: null, version: 2 }),
                ]);
            }
            for (const action of ['accepted', 'declined', 'expired'] as const) {
                const r = by(invite_event(kind, action));
                expect(r.map((x) => x.channel).sort()).toEqual(['org.email', 'org.in_app']);
                expect(r.every((x) => x.lock_reason === null && x.recipients.join() === 'org_owners,inviter')).toBe(true);
            }
            expect(by(invite_event(kind, 'revoked'))).toEqual([]);
        }
        expect(by(ORG_ABANDONED)).toEqual([expect.objectContaining({ channel: 'org.in_app', recipients: ['inviter'], lock_reason: null })]);
        expect(by(USER_SETUP_SENT)).toEqual([]);
        expect(by('invite.org.sent')[0].system_key).toBe('invite.sent.invitee');
    });

    it('account orgs also get the locked account email rules, with In-app copies except for the set-password email', () => {
        const extra = default_rule_specs(true).filter((r) => r.event.startsWith('user.'));
        const email = extra.filter((r) => r.channel === 'org.email');
        const in_app = extra.filter((r) => r.channel === 'org.in_app');
        expect(email.map((r) => r.event)).toEqual([USER_SETUP_SENT, USER_PASSWORD_RESET_SENT, USER_PASSWORD_CHANGED]);
        expect(email.every((r) => r.recipients.join() === 'user' && r.lock_reason)).toBe(true);
        expect(in_app.map((r) => r.event)).toEqual([USER_PASSWORD_RESET_SENT, USER_PASSWORD_CHANGED]);
        expect(in_app.every((r) => r.recipients.join() === 'user' && r.lock_reason === null)).toBe(true);
        expect(default_rule_specs(true)).toHaveLength(default_rule_specs(false).length + 5);
    });
});
