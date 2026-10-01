/**
 * Notification access.
 *
 * `require_authenticated_user_id` is the only helper left; the channel, rule
 * and custom-event rules live in the route policy and are tested here through
 * the policy engine (the handlers no longer repeat them).
 */

import { describe, it, expect } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import type { Request } from 'express';

import { require_authenticated_user_id } from '../../../src/notifications/notification_authz.js';
import type { AccessStore } from '../../../src/auth/route_policy/engine.js';
import { DEFAULT_ROLES } from '../../../src/auth/permissions.js';
import { policy_status } from '../../helpers/policy_decision.js';

const USER_ID = hub_legacy_uuid(1);

function make_req(user?: { id: string; role: string } | null): Request {
    return {
        auth: user ? { user: { id: user.id, role: user.role } } : { user: null },
    } as unknown as Request;
}

describe('require_authenticated_user_id', () => {
    it('returns trimmed user_id when authenticated', () => {
        const req = make_req({ id: ` ${USER_ID} `, role: 'user' });
        expect(require_authenticated_user_id(req)).toBe(USER_ID);
    });

    it('throws 401 when req.auth.user is null', () => {
        const req = make_req(null);
        expect(() => require_authenticated_user_id(req)).toThrow('Authentication required');
    });

    it('throws 401 when req.auth is missing', () => {
        const req = {} as unknown as Request;
        expect(() => require_authenticated_user_id(req)).toThrow('Authentication required');
    });
});


// ── Route policy: channels, rules, custom events ────────────────────

// Acme (org O1) with realm R1. op = realm operator + org operator,
// mem = realm member + org member, adm = org admin (no realm row),
// out = no standing anywhere.
const ORG_ROLE: Record<string, string> = { op: 'operator', mem: 'member', adm: 'admin' };
const REALM_ROLE: Record<string, 'operator' | 'member'> = { op: 'operator', mem: 'member' };
const role = (slug: string) => {
    const d = DEFAULT_ROLES.find((r) => r.slug === slug)!;
    return { slug: d.slug, is_system: d.is_system, permissions: [...d.permissions] };
};
const store: AccessStore = {
    realm: async (id) => (id === 'R1' ? { id: 'R1', org_id: 'O1', owner_user_id: null, deleted: false } : null),
    realm_by_slug: async () => null,
    realm_role: async (realm_id, user_id) => (realm_id === 'R1' ? REALM_ROLE[user_id] ?? null : null),
    org_role: async (org_id, user_id) => (org_id === 'O1' && ORG_ROLE[user_id] ? role(ORG_ROLE[user_id]) : null),
    org_id_by_slug: async () => null,
    daemon_in_realm: async () => false,
    record: async (kind, id, req) => {
        if (kind === 'channel' && id === 'ch_realm') return { realm_id: 'R1', org_id: null };
        if (kind === 'channel' && id === 'ch_org') return { realm_id: null, org_id: 'O1' };
        if (kind === 'channel' && id === 'ch_mine') {
            return req.auth?.user?.id === 'mem' ? { realm_ids: [], org_id: null, owner_user_id: 'mem' } : { realm_id: null, org_id: null };
        }
        if (kind === 'rule' && id === 'rule_realm') return { realm_id: 'R1', org_id: null };
        if (kind === 'rule' && id === 'rule_org') return { realm_id: null, org_id: 'O1' };
        if (kind === 'custom_event' && id === 'ce_realm') return { realm_id: 'R1' };
        if (kind === 'custom_event' && id === 'ce_hub') return { realm_id: null };
        return null;
    },
};
const as = (id: string, role_: 'user' | 'admin' = 'user') => ({ id, role: role_ });
const st = (route: string, caller: ReturnType<typeof as> | null, body: Record<string, unknown>) =>
    policy_status(`POST ${route}`, caller, body, store);

describe('route policy — notification channels', () => {
    it('realm channel create: operator yes, member 403, outsider 404, site admin yes', async () => {
        const body = { realm_id: 'R1', name: 'x' };
        expect(await st('/v1/notification_channels/create', as('op'), body)).toBe(200);
        expect(await st('/v1/notification_channels/create', as('mem'), body)).toBe(403);
        expect(await st('/v1/notification_channels/create', as('out'), body)).toBe(404);
        expect(await st('/v1/notification_channels/create', as('sam', 'admin'), body)).toBe(200);
    });

    it('org channel create needs channels.manage (org admin), operator 403, outsider 404', async () => {
        const body = { org_id: 'O1', name: 'x' };
        expect(await st('/v1/notification_channels/create', as('adm'), body)).toBe(200);
        expect(await st('/v1/notification_channels/create', as('op'), body)).toBe(403);
        expect(await st('/v1/notification_channels/create', as('out'), body)).toBe(404);
    });

    it('update realm channel uses channels.manage.realm; org channel uses channels.manage', async () => {
        expect(await st('/v1/notification_channels/update', as('op'), { id: 'ch_realm' })).toBe(200);
        expect(await st('/v1/notification_channels/update', as('mem'), { id: 'ch_realm' })).toBe(403);
        expect(await st('/v1/notification_channels/update', as('op'), { id: 'ch_org' })).toBe(403);
        expect(await st('/v1/notification_channels/update', as('adm'), { id: 'ch_org' })).toBe(200);
    });

    it('a personal channel: its owner yes, anyone else 404', async () => {
        expect(await st('/v1/notification_channels/remove', as('mem'), { id: 'ch_mine' })).toBe(200);
        expect(await st('/v1/notification_channels/remove', as('op'), { id: 'ch_mine' })).toBe(404);
    });

    it('test sends need channels.test (admins), not just operate', async () => {
        expect(await st('/v1/notification_channels/test', as('op'), { id: 'ch_realm' })).toBe(403);
        expect(await st('/v1/notification_channels/test', as('adm'), { id: 'ch_realm' })).toBe(200);
    });

    it('missing channel → 404', async () => {
        expect(await st('/v1/notification_channels/update', as('adm'), { id: 'nope' })).toBe(404);
    });
});

describe('route policy — notification rules (org and realm routes share one handler)', () => {
    for (const base of ['/v1/orgs', '/v1/realms']) {
        it(`${base}: realm_id set → realm operate + rules.manage.realm`, async () => {
            const body = { realm_id: 'R1', org_id: 'O1', event: 'run.failed' };
            expect(await st(`${base}/set_notification_rules`, as('op'), body)).toBe(200);
            expect(await st(`${base}/set_notification_rules`, as('mem'), body)).toBe(403);
            expect(await st(`${base}/set_notification_rules`, as('out'), body)).toBe(404);
        });

        it(`${base}: no realm_id → org rules.manage`, async () => {
            const body = { org_id: 'O1', event: 'run.failed' };
            expect(await st(`${base}/set_notification_rules`, as('adm'), body)).toBe(200);
            expect(await st(`${base}/set_notification_rules`, as('op'), body)).toBe(403);
            expect(await st(`${base}/get_notification_rules`, as('mem'), { org_id: 'O1' })).toBe(200);
            expect(await st(`${base}/get_notification_rules`, as('out'), { org_id: 'O1' })).toBe(404);
        });

        it(`${base}: neither realm_id nor org_id → 400`, async () => {
            expect(await st(`${base}/set_notification_rules`, as('adm'), { event: 'run.failed' })).toBe(400);
        });
    }

    it('remove: realm rule by realm standing, org rule by rules.manage', async () => {
        expect(await st('/v1/realms/remove_notification_rules', as('op'), { id: 'rule_realm' })).toBe(200);
        expect(await st('/v1/orgs/remove_notification_rules', as('op'), { id: 'rule_org' })).toBe(403);
        expect(await st('/v1/orgs/remove_notification_rules', as('adm'), { id: 'rule_org' })).toBe(200);
        expect(await st('/v1/orgs/remove_notification_rules', as('adm'), { id: 'nope' })).toBe(404);
    });
});

describe('route policy — custom events', () => {
    it('create: operate + rules.manage.realm', async () => {
        expect(await st('/v1/events/custom/create', as('op'), { realm_id: 'R1' })).toBe(200);
        expect(await st('/v1/events/custom/create', as('mem'), { realm_id: 'R1' })).toBe(403);
    });

    it('remove: realm event by realm standing; hub-wide event site admin only (S20)', async () => {
        expect(await st('/v1/events/custom/remove', as('op'), { id: 'ce_realm' })).toBe(200);
        expect(await st('/v1/events/custom/remove', as('adm'), { id: 'ce_hub' })).toBe(404);
        expect(await st('/v1/events/custom/remove', as('sam', 'admin'), { id: 'ce_hub' })).toBe(200);
    });

    it('a daemon token minted by a site admin is not a site admin', async () => {
        const d = await policy_status('POST /v1/events/custom/remove', { id: 'sam', daemon: { realm_id: 'R1' } }, { id: 'ce_hub' }, store);
        expect(d).toBe(403);
    });
});
