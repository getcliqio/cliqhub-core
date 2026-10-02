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

/** Details are stored as JSON text; callers get the object (an unreadable value comes back as `{ raw }`). */
function parse_details(v: unknown): Record<string, unknown> {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    if (typeof v !== 'string' || !v.trim()) return {};
    try {
        const parsed = JSON.parse(v);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
    } catch {
        return { raw: v };
    }
}

/** Count of entries per value of one field. */
export type AuditFacet = Array<{ value: string; label: string; count: number }>;

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
            details: parse_details(r.details),
            created_at: r.created_at,
        }));
    }

    async count_filtered(filters: AuditFilters): Promise<number> {
        return AuditLog.count({ where: audit_where(filters) });
    }

    /**
     * Entries per action, target type and admin, each counted under the other
     * filters (so picking one action still shows the other actions' counts).
     */
    async facets(filters: AuditFilters): Promise<{ action: AuditFacet; target_type: AuditFacet; admin: AuditFacet }> {
        const count = async (field: 'action' | 'target_type' | 'admin_id', drop: keyof AuditFilters) => {
            const rest = { ...filters, [drop]: undefined };
            const rows = await AuditLog.findAll({
                attributes: [field, [AuditLog.sequelize!.fn('COUNT', AuditLog.sequelize!.col('*')), 'count']],
                where: { ...audit_where(rest), [field]: { [Op.ne]: null } },
                group: [field],
                order: [[AuditLog.sequelize!.literal('count'), 'DESC']],
                limit: 50,
                raw: true,
            }) as unknown as Array<Record<string, unknown>>;
            return rows.map((r) => ({ value: String(r[field]), count: Number(r.count ?? 0) }));
        };
        const [action, target_type, admin] = await Promise.all([count('action', 'action'), count('target_type', 'target_type'), count('admin_id', 'admin_id')]);
        const users = admin.length
            ? await User.findAll({ where: { id: { [Op.in]: admin.map((a) => a.value) } }, attributes: ['id', 'username'], raw: true }) as unknown as Array<{ id: string; username: string }>
            : [];
        const names = new Map(users.map((u) => [String(u.id), u.username]));
        return {
            action: action.map((a) => ({ ...a, label: a.value })),
            target_type: target_type.map((a) => ({ ...a, label: a.value })),
            admin: admin.map((a) => ({ ...a, label: names.get(a.value) ?? 'deleted user' })),
        };
    }
}
