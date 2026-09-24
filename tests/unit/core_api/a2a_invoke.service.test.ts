import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hub_legacy_uuid } from '../../../src/lib/hub_legacy_uuid.js';

vi.mock('../../../src/models/index.js', () => ({
    Realm: { findByPk: vi.fn() },
    Run: { findByPk: vi.fn() },
    RealmMember: { findOne: vi.fn() },
}));

vi.mock('../../../src/db/models/index.js', () => ({
    Team: { findOne: vi.fn() },
    TeamVersion: { findOne: vi.fn() },
}));

vi.mock('../../../src/services/realm_a2a.service.js', () => ({
    RealmA2aService: {
        is_enabled: vi.fn(),
    },
}));

vi.mock('../../../src/services/dispatch.service.js', () => ({
    DispatchService: {
        enqueue: vi.fn(),
    },
}));

vi.mock('../../../src/services/queue.service.js', () => ({
    QueueService: {
        get: vi.fn(),
    },
}));

vi.mock('../../../src/services/in_app_notification.service.js', () => ({
    InAppNotificationService: {
        create_from_payload: vi.fn(),
    },
}));

vi.mock('../../../src/events/submit.service.js', () => ({
    EventSubmitService: {
        submit: vi.fn(),
    },
}));

vi.mock('../../../src/lib/api_error.js', () => ({
    ApiError: {
        forbidden: (msg: string) => Object.assign(new Error(msg), { status_code: 403 }),
        not_found: (msg: string) => Object.assign(new Error(msg), { status_code: 404 }),
        bad_request: (msg: string) => Object.assign(new Error(msg), { status_code: 400 }),
    },
}));

import { A2aInvokeService } from '../../../src/services/a2a_invoke.service.js';
import { Realm, Run, RealmMember } from '../../../src/models/index.js';
import { Team as HubTeam, TeamVersion } from '../../../src/db/models/index.js';
import { RealmA2aService } from '../../../src/services/realm_a2a.service.js';
import { DispatchService } from '../../../src/services/dispatch.service.js';
import { QueueService } from '../../../src/services/queue.service.js';
import { InAppNotificationService } from '../../../src/services/in_app_notification.service.js';
import { EventSubmitService } from '../../../src/events/submit.service.js';

describe('A2aInvokeService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(RealmA2aService.is_enabled).mockResolvedValue(true);
        vi.mocked(Realm.findByPk).mockResolvedValue({
            id: 'r1',
            deleted: false,
            owner_user_id: '42',
            team_list: [{ scope: 'cliq', slug: 'hello-world' }],
        } as any);
        vi.mocked(HubTeam.findOne).mockResolvedValue({ id: hub_legacy_uuid(10), name: 'hello-world' } as any);
        vi.mocked(TeamVersion.findOne).mockResolvedValue({
            capability_json: JSON.stringify({
                inputs: [{ name: 'message', required: true }],
            }),
        } as any);
    });

    it('enqueues a Hub run for a valid skill', async () => {
        vi.mocked(DispatchService.enqueue).mockResolvedValue({
            item: {
                id: 'q1',
                realm_id: 'r1',
                status: 'running',
                run_id: 'run-1',
                error: null,
                results: null,
                payload: { team_id: 'cliq/hello-world' },
            },
        } as any);

        const task = await A2aInvokeService.invoke_skill({
            realm_id: 'r1',
            skill_id: 'cliq/hello-world',
            inputs: { message: 'hi' },
        });

        expect(DispatchService.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                realm_id: 'r1',
                kind: 'run',
                user_id: '42',
                payload: expect.objectContaining({
                    team_id: 'cliq/hello-world',
                    inputs: { message: 'hi' },
                }),
            }),
        );
        expect(task.id).toBe('q1');
        expect(task.status.state).toBe('working');
        expect(task.metadata.run_id).toBe('run-1');
    });

    it('rejects missing required inputs', async () => {
        await expect(
            A2aInvokeService.invoke_skill({
                realm_id: 'r1',
                skill_id: 'cliq/hello-world',
                inputs: {},
            }),
        ).rejects.toMatchObject({ status_code: 400 });
        expect(DispatchService.enqueue).not.toHaveBeenCalled();
    });

    it('rejects unknown skill', async () => {
        await expect(
            A2aInvokeService.invoke_skill({
                realm_id: 'r1',
                skill_id: 'cliq/other',
                inputs: { message: 'x' },
            }),
        ).rejects.toMatchObject({ status_code: 404 });
    });

    it('rejects when A2A disabled', async () => {
        vi.mocked(RealmA2aService.is_enabled).mockResolvedValue(false);
        await expect(
            A2aInvokeService.invoke_skill({
                realm_id: 'r1',
                skill_id: 'cliq/hello-world',
                inputs: { message: 'x' },
            }),
        ).rejects.toMatchObject({ status_code: 403 });
    });

    it('get_task maps queue status', async () => {
        vi.mocked(QueueService.get).mockResolvedValue({
            id: 'q1',
            realm_id: 'r1',
            status: 'completed',
            run_id: 'run-1',
            error: null,
            results: [{ ok: true }],
            payload: { team_id: 'cliq/hello-world' },
        } as any);
        vi.mocked(Run.findByPk).mockResolvedValue({ status: 'completed' } as any);

        const task = await A2aInvokeService.get_task('q1', 'r1');
        expect(task.status.state).toBe('completed');
        expect(task.artifacts?.[0].parts[0].data).toEqual([{ ok: true }]);
    });

    it('notify_member creates in-app notification for realm member', async () => {
        vi.mocked(RealmMember.findOne).mockResolvedValue({ member_id: '99' } as any);
        vi.mocked(InAppNotificationService.create_from_payload).mockResolvedValue({
            id: 'n1',
        } as any);
        vi.mocked(EventSubmitService.submit).mockResolvedValue({} as any);

        const task = await A2aInvokeService.invoke_skill({
            realm_id: 'r1',
            skill_id: 'notify_member',
            inputs: { member_id: '99', message: 'hello' },
        });

        expect(InAppNotificationService.create_from_payload).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'a2a.notify_member',
                message: 'hello',
                realm_id: 'r1',
            }),
        );
        expect(EventSubmitService.submit).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'custom.a2a.notify_member' }),
        );
        expect(task.status.state).toBe('completed');
        expect(DispatchService.enqueue).not.toHaveBeenCalled();
    });

    it('notify_member rejects non-members', async () => {
        vi.mocked(RealmMember.findOne).mockResolvedValue(null as any);
        await expect(
            A2aInvokeService.invoke_skill({
                realm_id: 'r1',
                skill_id: 'notify_member',
                inputs: { member_id: 'nope', message: 'x' },
            }),
        ).rejects.toMatchObject({ status_code: 400 });
    });
});
