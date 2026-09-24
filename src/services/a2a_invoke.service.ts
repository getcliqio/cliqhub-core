import { randomUUID } from 'node:crypto';
import { Realm, RealmMember, Run } from '../models/index.js';
import { Team as HubTeam, TeamVersion } from '../db/models/index.js';
import { ApiError } from '../lib/api_error.js';
import { RealmA2aService } from './realm_a2a.service.js';
import { DispatchService } from './dispatch.service.js';
import { QueueService } from './queue.service.js';
import type { Queue_item_dto } from './queue.service.js';
import { InAppNotificationService } from './in_app_notification.service.js';
import { EventSubmitService } from '../events/submit.service.js';

export type A2a_task_state =
    | 'submitted'
    | 'working'
    | 'completed'
    | 'failed'
    | 'canceled';

export interface A2a_task {
    id: string;
    contextId?: string;
    status: {
        state: A2a_task_state;
        message?: string;
    };
    metadata: {
        realm_id: string;
        skill_id: string;
        queue_item_id: string;
        run_id: string | null;
    };
    artifacts?: Array<{
        name: string;
        parts: Array<{ kind: string; data?: unknown; text?: string }>;
    }>;
}

function map_queue_status(status: string): A2a_task_state {
    if (status === 'completed') return 'completed';
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'canceled';
    if (status === 'queued') return 'submitted';
    return 'working';
}

function parse_inputs_schema(capability_json: string | null | undefined): Array<{
    name: string;
    required?: boolean;
}> {
    if (!capability_json) return [];
    try {
        const parsed = JSON.parse(capability_json) as { inputs?: unknown };
        if (!Array.isArray(parsed.inputs)) return [];
        return parsed.inputs
            .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
            .map((item) => ({
                name: String(item.name ?? item.key ?? ''),
                required: Boolean(item.required),
            }))
            .filter((item) => item.name);
    } catch {
        return [];
    }
}

function validate_inputs(
    schema: Array<{ name: string; required?: boolean }>,
    inputs: Record<string, unknown>,
): void {
    for (const field of schema) {
        if (!field.required) continue;
        const value = inputs[field.name];
        if (value === undefined || value === null || value === '') {
            throw ApiError.bad_request(`Missing required input '${field.name}'`);
        }
    }
}

function task_from_queue(
    item: Queue_item_dto,
    skill_id: string,
): A2a_task {
    const state = map_queue_status(item.status);
    const task: A2a_task = {
        id: item.id,
        status: {
            state,
            message: item.error ?? undefined,
        },
        metadata: {
            realm_id: item.realm_id,
            skill_id,
            queue_item_id: item.id,
            run_id: item.run_id,
        },
    };

    if (state === 'completed' && item.results) {
        task.artifacts = [
            {
                name: 'result',
                parts: [{ kind: 'data', data: item.results }],
            },
        ];
    }

    return task;
}

export class A2aInvokeService {
    /**
     * Invoke a realm skill (installed team) via Hub dispatch queue.
     * Actor is the realm owner (automation principal).
     */
    static async invoke_skill(input: {
        realm_id: string;
        skill_id: string;
        inputs?: Record<string, unknown>;
        context_id?: string;
    }): Promise<A2a_task> {
        const enabled = await RealmA2aService.is_enabled(input.realm_id);
        if (!enabled) throw ApiError.forbidden('A2A is disabled for this realm');

        const realm = await Realm.findByPk(input.realm_id);
        if (!realm || realm.deleted) throw ApiError.not_found('Realm not found');

        const skill_id = input.skill_id.trim();
        if (skill_id === 'notify_member') {
            return A2aInvokeService._invoke_notify_member(realm, input.inputs ?? {});
        }

        if (!skill_id.includes('/')) {
            throw ApiError.bad_request('skill_id must be scope/slug');
        }

        const [scope, slug] = skill_id.split('/');
        const on_list = (realm.team_list ?? []).some(
            (entry) => entry.scope === scope && entry.slug === slug,
        );
        if (!on_list) {
            throw ApiError.not_found(`Skill '${skill_id}' is not installed on this realm`);
        }

        const hub_team = await HubTeam.findOne({ where: { scope, name: slug } });
        if (!hub_team) throw ApiError.not_found(`Team '${skill_id}' not found`);

        const latest = await TeamVersion.findOne({
            where: { team_id: hub_team.id },
            order: [['published_at', 'DESC']],
        });
        if (!latest) throw ApiError.not_found(`Team '${skill_id}' has no published version`);

        const inputs = input.inputs ?? {};
        validate_inputs(parse_inputs_schema(latest.capability_json), inputs);

        const owner_user_id = String(realm.owner_user_id);
        const { item } = await DispatchService.enqueue({
            realm_id: realm.id,
            kind: 'run',
            user_id: owner_user_id,
            payload: {
                team_id: skill_id,
                inputs,
                ...(input.context_id ? { a2a_context_id: input.context_id } : {}),
                a2a_request_id: randomUUID(),
            },
        });

        return task_from_queue(item, skill_id);
    }

    private static async _invoke_notify_member(
        realm: { id: string; owner_user_id: string },
        inputs: Record<string, unknown>,
    ): Promise<A2a_task> {
        const member_id = String(inputs.member_id ?? inputs.user_id ?? '').trim();
        const message = String(inputs.message ?? '').trim();
        const title = String(inputs.title ?? 'A2A notification').trim() || 'A2A notification';

        if (!member_id) throw ApiError.bad_request("Missing required input 'member_id'");
        if (!message) throw ApiError.bad_request("Missing required input 'message'");

        const member = await RealmMember.findOne({
            where: {
                realm_id: realm.id,
                member_type: 'user',
                member_id,
            },
        });
        if (!member) {
            throw ApiError.bad_request(`User '${member_id}' is not a member of this realm`);
        }

        const notification = await InAppNotificationService.create_from_payload({
            event: 'a2a.notify_member',
            title,
            message,
            realm_id: realm.id,
            severity: 'info',
            target_user_id: member_id,
        } as any);

        try {
            await EventSubmitService.submit({
                type: 'custom.a2a.notify_member',
                realm_id: realm.id,
                title,
                message,
                severity: 'info',
                actor_id: String(realm.owner_user_id),
                payload: {
                    target_user_id: member_id,
                    notification_id: notification.id,
                },
            });
        } catch {
            // In-app already persisted; channel fan-out is best-effort.
        }

        const task_id = randomUUID();
        return {
            id: task_id,
            status: { state: 'completed' },
            metadata: {
                realm_id: realm.id,
                skill_id: 'notify_member',
                queue_item_id: task_id,
                run_id: null,
            },
            artifacts: [
                {
                    name: 'notification',
                    parts: [{
                        kind: 'data',
                        data: {
                            notification_id: notification.id,
                            member_id,
                        },
                    }],
                },
            ],
        };
    }

    static async get_task(task_id: string, realm_id?: string): Promise<A2a_task> {
        const item = await QueueService.get(task_id);
        if (realm_id && item.realm_id !== realm_id) {
            throw ApiError.not_found('Task not found');
        }

        const enabled = await RealmA2aService.is_enabled(item.realm_id);
        if (!enabled) throw ApiError.forbidden('A2A is disabled for this realm');

        const skill_id = typeof item.payload?.team_id === 'string'
            ? item.payload.team_id
            : 'unknown';

        const task = task_from_queue(item, skill_id);

        if (item.run_id) {
            const run = await Run.findByPk(item.run_id);
            if (run) {
                const run_status = String((run as { status?: string }).status ?? '');
                if (run_status === 'completed' || run_status === 'failed' || run_status === 'cancelled') {
                    task.status.state = map_queue_status(run_status);
                }
                if (!task.artifacts && run_status === 'completed') {
                    task.artifacts = [
                        {
                            name: 'run',
                            parts: [{
                                kind: 'data',
                                data: {
                                    run_id: item.run_id,
                                    status: run_status,
                                },
                            }],
                        },
                    ];
                }
            }
        }

        return task;
    }
}
