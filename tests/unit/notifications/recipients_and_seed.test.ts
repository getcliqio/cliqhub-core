import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setup_sequelize_mocks } from '../../helpers/mock_sequelize.js';
setup_sequelize_mocks();

import { ChannelDestination, NotificationChannel, NotificationRule, Org, OrgMember, OrgRole, User } from '../../../src/models/index.js';
import { resolve_recipients } from '../../../src/notifications/recipients.js';
import { OrgSeedService, default_rule_specs } from '../../../src/services/org_seed.service.js';
import type { InviteEventData } from '../../../src/notifications/org_events.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const INVITER = '22222222-2222-4222-8222-222222222222';
const data: InviteEventData = {
    invite_id: 'inv', kind: 'org', role: 'member', invitee_email: 'New@Example.test',
    inviter: { id: INVITER, display_name: 'Inviter' }, org: { slug: 'acme', display_name: 'Acme' }, realm: null,
    expires_at: '2026-10-16T00:00:00.000Z', send_count: 1,
};
const user = (id: string, email: string) => ({ id, email, display_name: '', username: email.split('@')[0] });

describe('resolve_recipients', () => {
    beforeEach(() => vi.clearAllMocks());

    it('invitee without an account is just the normalized address', async () => {
        vi.mocked(User.findOne).mockResolvedValueOnce(null);
        expect(await resolve_recipients(['invitee'], { org_id: 'o', data })).toEqual([
            { email: 'new@example.test', user_id: null, display_name: null, selector: 'invitee' },
        ]);
    });

    it('a deleted invitee account receives nothing', async () => {
        vi.mocked(User.findOne).mockResolvedValueOnce({ ...user('u', 'new@example.test'), deleted_at: new Date() } as never);
        expect(await resolve_recipients(['invitee'], { org_id: 'o', data })).toEqual([]);
    });

    it('org owners then the inviter, de-duplicated by email, in selector order', async () => {
        vi.mocked(OrgRole.findOne).mockResolvedValueOnce({ id: 'role-owner' } as never);
        vi.mocked(OrgMember.findAll).mockResolvedValueOnce([{ user_id: OWNER }] as never);
        vi.mocked(User.findAll)
            .mockResolvedValueOnce([user(OWNER, 'owner@x.test')] as never)
            .mockResolvedValueOnce([user(INVITER, 'OWNER@x.test')] as never);
        const out = await resolve_recipients(['org_owners', 'inviter'], { org_id: 'o', data });
        expect(out).toEqual([expect.objectContaining({ email: 'owner@x.test', user_id: OWNER, selector: 'org_owners', display_name: 'owner' })]);
        expect(vi.mocked(OrgMember.findAll).mock.calls[0][0]).toMatchObject({ where: { org_id: 'o', role_id: 'role-owner', status: 'active', deleted_at: null } });
    });

    it('selectors that do not apply, or are not selectors, yield nobody without a query', async () => {
        expect(await resolve_recipients(['user', 'everyone'], { org_id: 'o', data })).toEqual([]);
        expect(User.findAll).not.toHaveBeenCalled();
    });
});

describe('OrgSeedService.seed_org', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates both channels and every default rule in the caller transaction, then marks the org', async () => {
        const t = { id: 'tx' } as never;
        const result = await OrgSeedService.seed_org('org-1', { account: true, transaction: t });
        expect(result).toEqual({ channels_created: 2, rules_created: default_rule_specs(true).length });
        const channels = vi.mocked(NotificationChannel.create).mock.calls.map((c) => c[0] as Record<string, unknown>);
        expect(channels).toEqual([
            expect.objectContaining({ org_id: 'org-1', name: 'Email', system_key: 'org.email', locked: true }),
            expect.objectContaining({ org_id: 'org-1', name: 'In-app', system_key: 'org.in_app', locked: false }),
        ]);
        expect(vi.mocked(ChannelDestination.create).mock.calls[0][0]).toMatchObject({ type: 'email', config: { provider: 'brevo' } });
        expect(vi.mocked(NotificationRule.create).mock.calls.every((c) => (c[1] as { transaction: unknown }).transaction === t)).toBe(true);
        expect(vi.mocked(Org.update).mock.calls[0][1]).toMatchObject({ where: { id: 'org-1' }, transaction: t });
    });

    it('creates nothing when every system row exists', async () => {
        vi.mocked(NotificationChannel.findOne).mockResolvedValue({ id: 'existing' } as never);
        vi.mocked(NotificationRule.findOne).mockResolvedValue({ id: 'existing' } as never);
        expect(await OrgSeedService.seed_org('org-1', { account: false })).toEqual({ channels_created: 0, rules_created: 0 });
        expect(NotificationChannel.create).not.toHaveBeenCalled();
        expect(NotificationRule.create).not.toHaveBeenCalled();
        vi.mocked(NotificationChannel.findOne).mockReset();
        vi.mocked(NotificationRule.findOne).mockReset();
    });
});
