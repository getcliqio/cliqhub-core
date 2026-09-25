/**
 * ReviewsController — body org_id tenancy (never X-Org-Id invent).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../../src/services/review_pending.service.js', () => ({
    ReviewPendingService: {
        list_for_user: vi.fn().mockResolvedValue({ reviews: [], total: 0 }),
    },
}));

vi.mock('../../../src/services/hug_reviews.service.js', () => ({
    HugReviewsService: {
        has_notification_for_user: vi.fn(),
        get: vi.fn().mockResolvedValue({ review_id: 'rev-1' }),
        create: vi.fn(),
        authorize_verdict_via_notification: vi.fn(),
        submit_verdict: vi.fn(),
        ack: vi.fn(),
    },
}));

vi.mock('../../../src/auth/permissions.js', () => ({
    require_permission: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/models/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/models/index.js')>();
    return {
        ...actual,
        Realm: { findByPk: vi.fn() },
    };
});

import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';
import { ApiError } from '../../../src/lib/api_error.js';
import type { AuthContext } from '../../../src/types/vo.js';
import { ReviewsController } from '../../../src/controllers/reviews_controller.js';
import { ReviewPendingService } from '../../../src/services/review_pending.service.js';
import { HugReviewsService } from '../../../src/services/hug_reviews.service.js';
import { require_permission } from '../../../src/auth/permissions.js';
import { reviews_get_schema } from '../../../src/schemas/reviews_schemas.js';

const ORG_A = hub_legacy_uuid(10);
const ORG_B = hub_legacy_uuid(20);
const REALM_A = hub_legacy_uuid(30);
const USER_A = hub_legacy_uuid(1);

function mock_res() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
}

function pat_auth(org_ids: string[]): AuthContext {
    return {
        user: { id: USER_A, username: 'alice', role: 'user' } as AuthContext['user'],
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
                current_org_id: ORG_B,
            }
            : undefined,
    } as unknown as Request;
}

describe('reviews_get_schema org_id', () => {
    it('requires org_id without realm_id', () => {
        expect(reviews_get_schema.safeParse({ limit: 1 }).success).toBe(false);
    });

    it('accepts org_id', () => {
        expect(reviews_get_schema.safeParse({ org_id: ORG_A, limit: 1 }).success).toBe(true);
    });

    it('realm_id does not require org_id', () => {
        expect(reviews_get_schema.safeParse({ realm_id: REALM_A }).success).toBe(true);
    });
});

describe('ReviewsController.get org_id tenancy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(ReviewPendingService.list_for_user).mockResolvedValue({ reviews: [], total: 0 } as never);
    });

    it('without org_id → ZodError; does not invent from current_org_id', async () => {
        const res = mock_res();
        const next = vi.fn() as NextFunction;
        await ReviewsController.get(make_req({ limit: 1 }, pat_auth([ORG_A])), res, next);
        expect(next.mock.calls[0][0]).toBeInstanceOf(ZodError);
        expect(ReviewPendingService.list_for_user).not.toHaveBeenCalled();
    });

    it('with membership org_id → list_for_user(org_id)', async () => {
        const res = mock_res();
        const next = vi.fn() as NextFunction;
        await ReviewsController.get(make_req({ org_id: ORG_A, limit: 10 }, pat_auth([ORG_A])), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(ReviewPendingService.list_for_user).toHaveBeenCalledWith(
            expect.objectContaining({ org_id: ORG_A, limit: 10 }),
        );
    });

    it('foreign org_id → 403', async () => {
        const res = mock_res();
        const next = vi.fn() as NextFunction;
        await ReviewsController.get(make_req({ org_id: ORG_B }, pat_auth([ORG_A])), res, next);
        const err = next.mock.calls[0][0] as ApiError;
        expect(err.status_code).toBe(403);
        expect(ReviewPendingService.list_for_user).not.toHaveBeenCalled();
    });
});

describe('ReviewsController.get_by_id org_id tenancy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(HugReviewsService.get).mockResolvedValue({ review_id: 'rev-1' } as never);
    });

    it('no notification and no org_id → 403 (no header invent)', async () => {
        vi.mocked(HugReviewsService.has_notification_for_user).mockResolvedValue(false);
        const res = mock_res();
        const next = vi.fn() as NextFunction;
        await ReviewsController.get_by_id(
            make_req({ review_id: 'rev-1' }, pat_auth([ORG_A])),
            res,
            next,
        );
        const err = next.mock.calls[0][0] as ApiError;
        expect(err.status_code).toBe(403);
        expect(require_permission).not.toHaveBeenCalled();
    });

    it('no notification with org_id → require_permission(body.org_id)', async () => {
        vi.mocked(HugReviewsService.has_notification_for_user).mockResolvedValue(false);
        const res = mock_res();
        const next = vi.fn() as NextFunction;
        await ReviewsController.get_by_id(
            make_req({ review_id: 'rev-1', org_id: ORG_A }, pat_auth([ORG_A])),
            res,
            next,
        );
        expect(next).not.toHaveBeenCalled();
        expect(require_permission).toHaveBeenCalledWith(
            ORG_A,
            String(USER_A),
            'reviews.view',
            expect.any(Object),
        );
    });

    it('with notification → no org_id required', async () => {
        vi.mocked(HugReviewsService.has_notification_for_user).mockResolvedValue(true);
        const res = mock_res();
        const next = vi.fn() as NextFunction;
        await ReviewsController.get_by_id(
            make_req({ review_id: 'rev-1' }, pat_auth([ORG_A])),
            res,
            next,
        );
        expect(next).not.toHaveBeenCalled();
        expect(require_permission).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });
});
