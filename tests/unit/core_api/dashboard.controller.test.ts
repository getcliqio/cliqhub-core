import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

vi.mock('../../../src/models/index.js', () => ({
	Workspace: { count: vi.fn(async () => 0) },
	Team: { count: vi.fn(async () => 0) },
	Agent: { count: vi.fn(async () => 0) },
	Scope: { name: 'Scope' },
	Realm: { findByPk: vi.fn() },
	Run: {
		count: vi.fn(async () => 0),
		findAll: vi.fn(async () => []),
	},
	InAppNotification: { findAll: vi.fn(async () => []) },
	RealmMember: { findAll: vi.fn(async () => []) },
	Review: { findAll: vi.fn(async () => []) },
}));

vi.mock('../../../src/services/daemon.service.js', () => ({
	DaemonService: {
		list: vi.fn(),
	},
}));

vi.mock('../../../src/services/realm.service.js', () => ({
	RealmService: {
		list_daemon_ids_for_user: vi.fn(async () => []),
		list_daemon_ids_for_user_in_org: vi.fn(async () => []),
		list_realms_by_daemon_ids: vi.fn(async () => new Map()),
		list_for_user: vi.fn(async () => ({ realms: [], total: 0 })),
	},
}));

vi.mock('../../../src/services/run.service.js', () => ({
	RunService: {
		list_recent: vi.fn(async () => ({ runs: [], total: 0 })),
	},
}));

vi.mock('../../../src/services/review_pending.service.js', () => ({
	ReviewPendingService: {
		list_for_user: vi.fn(async () => ({ reviews: [], total: 0 })),
	},
}));

import { DashboardController } from '../../../src/controllers/dashboard_controller.js';
import { DaemonService } from '../../../src/services/daemon.service.js';
import { RealmService } from '../../../src/services/realm.service.js';

const ORG_A = hub_legacy_uuid(10);
const USER_A = hub_legacy_uuid(1);

function mock_res() {
	const res = {
		status_code: 200,
		body: null as unknown,
		status(code: number) {
			this.status_code = code;
			return this;
		},
		json(body: unknown) {
			this.body = body;
			return this;
		},
	};
	return res as unknown as Response & { status_code: number; body: unknown };
}

function make_req(body: Record<string, unknown>, user_id: string = USER_A) {
	return {
		body,
		user: { user_id },
		auth: {
			user: { id: user_id, username: 'alice', role: 'user' },
			org_ids: [ORG_A],
			org_slugs: ['alice'],
			scopes: [],
			auth_via: 'pat',
		},
	} as unknown as Request;
}

describe('DashboardController.summary', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(RealmService.list_daemon_ids_for_user_in_org).mockResolvedValue([]);
		vi.mocked(RealmService.list_realms_by_daemon_ids).mockResolvedValue(new Map());
		vi.mocked(RealmService.list_for_user).mockResolvedValue({ realms: [], total: 0 });
	});

	it('401 when caller has no user_id', async () => {
		const req = { user: undefined, body: { org_id: ORG_A } } as unknown as Request;
		const res = mock_res();
		const next = vi.fn() as NextFunction;

		await DashboardController.summary(req, res, next);

		expect(res.status_code).toBe(401);
		expect(DaemonService.list).not.toHaveBeenCalled();
	});

	it('without org_id → next(ZodError)', async () => {
		const req = make_req({});
		const res = mock_res();
		const next = vi.fn() as NextFunction;
		await DashboardController.summary(req, res, next);
		expect(next).toHaveBeenCalled();
		expect(DaemonService.list).not.toHaveBeenCalled();
	});

	it('scopes daemon counts to DaemonService.list(user_id, { org_id })', async () => {
		vi.mocked(DaemonService.list).mockResolvedValueOnce({
			daemons: [
				{ id: 'd1', status: 'online' },
				{ id: 'd2', status: 'offline' },
				{ id: 'd3', status: 'online' },
			],
			total: 3,
		} as never);

		const req = make_req({ org_id: ORG_A });
		const res = mock_res();
		const next = vi.fn() as NextFunction;

		await DashboardController.summary(req, res, next);

		expect(DaemonService.list).toHaveBeenCalledWith(USER_A, { org_id: ORG_A });
		expect(next).not.toHaveBeenCalled();
		const body = res.body as {
			ok: boolean;
			counts: { daemons_online: number; daemons_total: number };
		};
		expect(body.ok).toBe(true);
		expect(body.counts.daemons_total).toBe(3);
		expect(body.counts.daemons_online).toBe(2);
	});

	it('returns zero daemon counts when user has no realm daemons', async () => {
		vi.mocked(DaemonService.list).mockResolvedValueOnce({ daemons: [], total: 0 });

		const req = make_req({ org_id: ORG_A }, hub_legacy_uuid(99));
		(req as { auth: { org_ids: string[] } }).auth.org_ids = [ORG_A];
		const res = mock_res();
		const next = vi.fn() as NextFunction;

		await DashboardController.summary(req, res, next);

		const body = res.body as {
			ok: boolean;
			counts: { daemons_online: number; daemons_total: number };
		};
		expect(body.counts.daemons_total).toBe(0);
		expect(body.counts.daemons_online).toBe(0);
	});
});
