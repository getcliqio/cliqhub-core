import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';

import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';
import {
    RealmDispatchQueue,
    type Realm_dispatch_kind,
    type Realm_dispatch_queue_attributes,
    type Realm_dispatch_queue_model,
    type Realm_dispatch_status,
} from '../models/realm_dispatch_queue.model.js';

const log = get_logger('queue');

export type Queue_item_dto = Realm_dispatch_queue_attributes;

function now_ms(): number {
    return Date.now();
}

function to_dto(row: Realm_dispatch_queue_model): Queue_item_dto {
    return {
        id: row.id,
        realm_id: row.realm_id,
        kind: row.kind,
        payload: (row.payload ?? {}) as Record<string, unknown>,
        priority: row.priority,
        status: row.status,
        claimed_by: row.claimed_by,
        claimed_at: row.claimed_at == null ? null : Number(row.claimed_at),
        run_id: row.run_id,
        results: row.results ?? null,
        submitted_by: row.submitted_by,
        submitted_at: Number(row.submitted_at),
        error: row.error,
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
    };
}

export class QueueService {
    static async create(input: {
        realm_id: string;
        kind: Realm_dispatch_kind;
        payload?: Record<string, unknown>;
        priority?: number;
        submitted_by: string;
        status?: Realm_dispatch_status;
    }): Promise<Queue_item_dto> {
        if (!input.realm_id.trim()) throw ApiError.bad_request('realm_id is required');
        if (!input.submitted_by.trim()) throw ApiError.bad_request('submitted_by is required');
        if (!input.kind) throw ApiError.bad_request('kind is required');

        const now = now_ms();
        const row = await RealmDispatchQueue.create({
            id: randomUUID(),
            realm_id: input.realm_id.trim(),
            kind: input.kind,
            payload: input.payload ?? {},
            priority: input.priority ?? 0,
            status: input.status ?? 'queued',
            claimed_by: null,
            claimed_at: null,
            run_id: null,
            results: null,
            submitted_by: input.submitted_by.trim(),
            submitted_at: now,
            error: null,
            created_at: now,
            updated_at: now,
        });
        return to_dto(row);
    }

    static async get(queue_item_id: string): Promise<Queue_item_dto> {
        const row = await RealmDispatchQueue.findByPk(queue_item_id);
        if (!row) throw ApiError.not_found(`Queue item '${queue_item_id}' not found`);
        return to_dto(row);
    }

    static async list_for_realm(
        realm_id: string,
        opts?: { status?: Realm_dispatch_status; limit?: number },
    ): Promise<Queue_item_dto[]> {
        const where: Record<string, unknown> = { realm_id };
        if (opts?.status) where.status = opts.status;
        const rows = await RealmDispatchQueue.findAll({
            where,
            order: [
                ['priority', 'DESC'],
                ['created_at', 'ASC'],
            ],
            limit: opts?.limit ?? 100,
        });
        return rows.map(to_dto);
    }

    /**
     * Atomic exclusive claim. Exactly one concurrent caller wins.
     * Uses conditional UPDATE … RETURNING so two simultaneous claims cannot both succeed.
     */
    static async claim(queue_item_id: string, daemon_id: string): Promise<Queue_item_dto> {
        const id = queue_item_id.trim();
        const daemon = daemon_id.trim();
        if (!id) throw ApiError.bad_request('queue_item_id is required');
        if (!daemon) throw ApiError.bad_request('daemon_id is required');

        const sequelize = RealmDispatchQueue.sequelize;
        if (!sequelize) throw ApiError.internal('Queue model is not initialized');

        const now = now_ms();
        const rows = await sequelize.query<Realm_dispatch_queue_attributes>(
            `
            UPDATE cliq."realm_dispatch_queue"
            SET
                "status" = 'claimed',
                "claimed_by" = :daemon_id,
                "claimed_at" = :now,
                "updated_at" = :now
            WHERE "id" = :id
              AND "status" IN ('queued', 'offered')
              AND "claimed_by" IS NULL
            RETURNING *
            `,
            {
                replacements: { id, daemon_id: daemon, now },
                type: QueryTypes.SELECT,
            },
        );

        const won = rows[0];
        if (!won) {
            const existing = await RealmDispatchQueue.findByPk(id);
            if (!existing) throw ApiError.not_found(`Queue item '${id}' not found`);
            log.info('claim_lost', {
                queue_item_id: id,
                daemon_id: daemon,
                realm_id: existing.realm_id,
                status: existing.status,
                claimed_by: existing.claimed_by,
            });
            throw ApiError.conflict(
                `Queue item '${id}' already claimed`
                + (existing.claimed_by ? ` by '${existing.claimed_by}'` : ''),
            );
        }

        log.info('claim_won', {
            queue_item_id: won.id,
            daemon_id: daemon,
            realm_id: won.realm_id,
            kind: won.kind,
        });

        return {
            id: won.id,
            realm_id: won.realm_id,
            kind: won.kind,
            payload: (won.payload ?? {}) as Record<string, unknown>,
            priority: Number(won.priority),
            status: won.status,
            claimed_by: won.claimed_by,
            claimed_at: won.claimed_at == null ? null : Number(won.claimed_at),
            run_id: won.run_id,
            results: won.results ?? null,
            submitted_by: won.submitted_by,
            submitted_at: Number(won.submitted_at),
            error: won.error,
            created_at: Number(won.created_at),
            updated_at: Number(won.updated_at),
        };
    }

    static async mark_offered(queue_item_id: string): Promise<Queue_item_dto> {
        const row = await RealmDispatchQueue.findByPk(queue_item_id);
        if (!row) throw ApiError.not_found(`Queue item '${queue_item_id}' not found`);
        if (row.status !== 'queued' && row.status !== 'offered') {
            throw ApiError.conflict(`Queue item '${queue_item_id}' is '${row.status}', cannot offer`);
        }
        const now = now_ms();
        row.status = 'offered';
        row.updated_at = now;
        await row.save();
        const dto = to_dto(row);
        log.info('queue_offered', {
            queue_item_id: dto.id,
            realm_id: dto.realm_id,
            kind: dto.kind,
        });
        return dto;
    }

    static async set_results(
        queue_item_id: string,
        input: {
            status: Realm_dispatch_status;
            results?: unknown[];
            error?: string | null;
            run_id?: string | null;
        },
    ): Promise<Queue_item_dto> {
        const row = await RealmDispatchQueue.findByPk(queue_item_id);
        if (!row) throw ApiError.not_found(`Queue item '${queue_item_id}' not found`);
        const now = now_ms();
        row.status = input.status;
        if (input.results !== undefined) row.results = input.results;
        if (input.error !== undefined) row.error = input.error;
        if (input.run_id !== undefined) row.run_id = input.run_id;
        row.updated_at = now;
        await row.save();
        const dto = to_dto(row);
        log.info('queue_status', {
            queue_item_id: dto.id,
            realm_id: dto.realm_id,
            kind: dto.kind,
            status: dto.status,
            run_id: dto.run_id,
            claimed_by: dto.claimed_by,
            error: dto.error,
        });
        return dto;
    }
}
