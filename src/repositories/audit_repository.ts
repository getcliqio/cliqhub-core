import { Op, type Transaction } from 'sequelize';
import { list_order, type SortColumns, type SortDir } from '../lib/list_sort.js';
import { AuditLog, User } from '../models/index.js';

type AuditFilters = { action?: string; target_type?: string; admin_id?: string; target_id?: string; since_ms?: number; until_ms?: number };

function audit_where(filters: AuditFilters): Record<string | symbol, unknown> {
    const where: Record<string | symbol, unknown> = {};
    if (filters.action) where.action = filters.action;
    if (filters.target_type) where.target_type = filters.target_type;
    if (filters.admin_id !== undefined) where.admin_id = filters.admin_id;
    if (filters.target_id) where.target_id = filters.target_id;
    if (filters.since_ms != null || filters.until_ms != null) {
        where.created_at = {
            ...(filters.since_ms != null ? { [Op.gte]: new Date(filters.since_ms) } : {}),
            ...(filters.until_ms != null ? { [Op.lt]: new Date(filters.until_ms) } : {}),
        };
    }
    return where;
}
import { BaseRepository } from './base_repository.js';

/** `/internal/reports/audit` sort keys. */
export type AuditSortKey = 'created_at' | 'action';

/** Audit sort key → ORDER BY. */
const AUDIT_SORT_COLUMNS: SortColumns<AuditSortKey> = {
    created_at: (d) => [['created_at', d]],
    action: (d) => [['action', d]],
};

export class AuditRepository extends BaseRepository<AuditLog> {
    protected readonly model = AuditLog;
    /** Records one admin action (inside `transaction` when given, so it commits or rolls back with the change). */
    async create(admin_id: string, action: string, target_type: string, target_id: string | number, details: Record<string, unknown> = {}, transaction?: Transaction): Promise<void> {
        await AuditLog.create({ admin_id, action, target_type, target_id: String(target_id), details: JSON.stringify(details) }, { transaction });
    }

    /** One page of entries, newest first unless `sort` says otherwise (ties by id). */
    async list_paginated(filters: AuditFilters, limit: number, offset: number, sort: { sort_by?: AuditSortKey; sort_dir?: SortDir } = {}) {
        const where = audit_where(filters);

        const rows = await AuditLog.findAll({
            where,
            include: [{ model: User, attributes: ['username'] }],
            order: list_order(AUDIT_SORT_COLUMNS, sort, [['created_at', 'DESC']]),
            limit,
            offset,
            raw: true,
            nest: true,
        });

        return rows.map((r: any) => ({
            id: r.id,
            admin_id: r.admin_id,
            admin_username: r.User?.username ?? null,
            action: r.action,
            target_type: r.target_type,
            target_id: r.target_id,
            details: r.details,
            created_at: r.created_at,
        }));
    }

    async count_filtered(filters: AuditFilters): Promise<number> {
        return AuditLog.count({ where: audit_where(filters) });
    }
}
