/**
 * NotificationsController — body org_id tenancy (never X-Org-Id invent).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../../../src/services/notification.service.js', () => ({
    NotificationService: {
        list_channels: vi.fn().mockResolvedValue([]),
        create_channel: vi.fn().mockResolvedValue({
            id: 'ch-account-1',
            realm_id: null,
            org_id: '00000000-0000-4000-8000-00000000000a',
            name: 'ops',
            enabled: true,
        }),
        get_channel: vi.fn(),
        update_channel: vi.fn(),
        remove_channel: vi.fn().mockResolvedValue(true),
        test_channel: vi.fn().mockResolvedValue({ delivered: 1, errors: [] }),
        detect_channel_ref_cycles: vi.fn().mockResolvedValue(undefined),
        find_enabled_channels: vi.fn().mockResolvedValue([]),
        list_rules: vi.fn().mockResolvedValue([]),
        list_effective_rules: vi.fn().mockResolvedValue([]),
        set_rule: vi.fn().mockResolvedValue({
            id: '00000000-0000-4000-8000-000000000063',
            event: 'run.failed',
            channel_id: 'ch-account-1',
        }),
        remove_rule: vi.fn().mockResolvedValue(true),
    },
}));

vi.mock('../../../src/services/in_app_notification.service.js', () => ({
    InAppNotificationService: {
        list_for_user: vi.fn().mockResolvedValue({ notifications: [], total: 0 }),
    },
}));

vi.mock('../../../src/notifications/notification_authz.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/notifications/notification_authz.js')>();
    return {
        ...actual,
        require_authenticated_user_id: vi.fn().mockReturnValue('00000000-0000-4000-8000-000000000001'),
        require_account_notification_admin: vi.fn().mockResolvedValue('00000000-0000-4000-8000-000000000001'),
        require_realm_notification_admin: vi.fn().mockResolvedValue(undefined),
        require_realm_notification_member: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('../../../src/models/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/models/index.js')>();
    return {
        ...actual,
        Realm: {
            findByPk: vi.fn(),
        },
        NotificationRule: {
            findByPk: vi.fn(),
        },
    };
});

import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { ApiError } from '../../../src/lib/api_error.js';
import type { AuthContext } from '../../../src/types/vo.js';
import {
    NotificationChannelsCreateInput,
    NotificationChannelsGetInput,
    NotificationRulesListInput,
    NotificationRulesSetInput,
    NotificationsGetInput,
} from '../../../src/schemas/notifications/inputs.js';
import { NotificationsController } from '../../../src/controllers/notifications_controller.js';
import { NotificationService } from '../../../src/services/notification.service.js';
import { InAppNotificationService } from '../../../src/services/in_app_notification.service.js';
import { require_account_notification_admin } from '../../../src/notifications/notification_authz.js';

const ORG_A = hub_legacy_uuid(10);
const ORG_B = hub_legacy_uuid(20);
const REALM_A = hub_legacy_uuid(30);
const CHANNEL_A = 'ch-account-1';
const USER_A = hub_legacy_uuid(1);

function mock_res() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

function pat_auth(org_ids: string[], role: 'user' | 'admin' = 'user'): AuthContext {
    return {
        user: { id: USER_A, username: 'alice', role } as AuthContext['user'],
        org_slugs: ['alice'],
        org_ids,
        scopes: [],
        auth_via: 'pat',
    };
}

function make_req(body: Record<string, unknown>, auth?: AuthContext) {
    return {
        body,
        auth,
        user: auth?.user
            ? {
                user_id: String(auth.user.id),
                email: 'alice@test.com',
                org_ids: auth.org_ids,
                role: auth.user.role,
            }
            : undefined,
    } as unknown as Request;
}

describe('Notification Zod org_id refinements', () => {
    it('account channel create requires org_id', () => {
        const r = NotificationChannelsCreateInput.safeParse({
            name: 'ops',
            destinations: [{ type: 'cliqhub' }],
        });
        expect(r.success).toBe(false);
    });

    it('account channel create accepts org_id', () => {
        const r = NotificationChannelsCreateInput.safeParse({
            org_id: ORG_A,
            name: 'ops',
            destinations: [{ type: 'cliqhub' }],
        });
        expect(r.success).toBe(true);
    });

    it('realm channel create does not require org_id', () => {
        const r = NotificationChannelsCreateInput.safeParse({
            realm_id: REALM_A,
            name: 'ops',
            destinations: [{ type: 'cliqhub' }],
        });
        expect(r.success).toBe(true);
    });

    it('account channel get requires org_id', () => {
        const r = NotificationChannelsGetInput.safeParse({ account: true });
        expect(r.success).toBe(false);
    });

    it('org rules list requires org_id', () => {
        const r = NotificationRulesListInput.safeParse({});
        expect(r.success).toBe(false);
    });

    it('org rules set requires org_id', () => {
        const r = NotificationRulesSetInput.safeParse({
            event: 'run.failed',
            channel_id: CHANNEL_A,
        });
        expect(r.success).toBe(false);
    });

    it('inbox requires org_id', () => {
        const r = NotificationsGetInput.safeParse({ limit: 10 });
        expect(r.success).toBe(false);
    });

    it('inbox accepts org_id', () => {
        const r = NotificationsGetInput.safeParse({ org_id: ORG_A, limit: 10 });
        expect(r.success).toBe(true);
    });
});

describe('NotificationsController org_id tenancy', () => {
    const controller = new NotificationsController();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(require_account_notification_admin).mockResolvedValue(USER_A);
        vi.mocked(NotificationService.create_channel).mockResolvedValue({
            id: CHANNEL_A,
            realm_id: null,
            org_id: ORG_A,
            name: 'ops',
            enabled: true,
        } as never);
        vi.mocked(InAppNotificationService.list_for_user).mockResolvedValue({
            notifications: [],
            total: 0,
        } as never);
    });

    it('channels_create without org_id → 422', async () => {
        const res = mock_res();
        const req = make_req(
            { name: 'ops', destinations: [{ type: 'cliqhub' }] },
            pat_auth([ORG_A]),
        );
        await expect(controller.channels_create(req as never, res as never)).rejects.toMatchObject({
            status: 422,
        });
    });

    it('channels_create with org_id not in membership → 403', async () => {
        const res = mock_res();
        const req = make_req(
            { org_id: ORG_B, name: 'ops', destinations: [{ type: 'cliqhub' }] },
            pat_auth([ORG_A]),
        );
        let caught: unknown;
        try {
            await controller.channels_create(req as never, res as never);
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(ApiError);
        expect((caught as ApiError).status_code).toBe(403);
    });

    it('channels_create with body org_id → 200 and persists org_id', async () => {
        const res = mock_res();
        const req = make_req(
            { org_id: ORG_A, name: 'ops', destinations: [{ type: 'cliqhub' }] },
            pat_auth([ORG_A]),
        );
        await controller.channels_create(req as never, res as never);
        expect(NotificationService.create_channel).toHaveBeenCalledWith(
            expect.objectContaining({ org_id: ORG_A, realm_id: null }),
        );
        expect(require_account_notification_admin).toHaveBeenCalledWith(req, ORG_A);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('channels_create realm_id only → no org invent', async () => {
        const res = mock_res();
        const req = make_req(
            { realm_id: REALM_A, name: 'ops', destinations: [{ type: 'cliqhub' }] },
            pat_auth([ORG_A]),
        );
        await controller.channels_create(req as never, res as never);
        expect(NotificationService.create_channel).toHaveBeenCalledWith(
            expect.objectContaining({ realm_id: REALM_A, org_id: null }),
        );
        expect(require_account_notification_admin).not.toHaveBeenCalled();
    });

    it('inbox_get without org_id → 422', async () => {
        const res = mock_res();
        const req = make_req({ limit: 10 }, pat_auth([ORG_A]));
        await expect(controller.inbox_get(req as never, res as never)).rejects.toMatchObject({
            status: 422,
        });
    });

    it('inbox_get with org_id → list_for_user uses body.org_id', async () => {
        const res = mock_res();
        const req = make_req({ org_id: ORG_A, limit: 10 }, pat_auth([ORG_A]));
        await controller.inbox_get(req as never, res as never);
        expect(InAppNotificationService.list_for_user).toHaveBeenCalledWith(
            expect.objectContaining({ org_id: ORG_A, user_id: USER_A }),
        );
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('rules_list org-global without org_id → 422', async () => {
        const res = mock_res();
        const req = make_req({}, pat_auth([ORG_A]));
        await expect(controller.rules_list(req as never, res as never)).rejects.toMatchObject({
            status: 422,
        });
    });

    it('rules_set org-global with org_id → set_rule gets org_id', async () => {
        const res = mock_res();
        const req = make_req(
            { org_id: ORG_A, event: 'run.failed', channel_id: CHANNEL_A },
            pat_auth([ORG_A]),
        );
        await controller.rules_set(req as never, res as never);
        expect(NotificationService.set_rule).toHaveBeenCalledWith(
            expect.objectContaining({ org_id: ORG_A, realm_id: null }),
        );
    });
});
