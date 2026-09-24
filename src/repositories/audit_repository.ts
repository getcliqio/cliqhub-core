import { AuditLog, User } from '../db/models/index.js';

export class AuditRepository {
    async create(admin_id: string, action: string, target_type: string, target_id: string | number, details: Record<string, unknown> = {}): Promise<void> {
        await AuditLog.create({ admin_id, action, target_type, target_id: String(target_id), details: JSON.stringify(details) });
    }

    async list_paginated(filters: { action?: string; target_type?: string; admin_id?: string }, limit: number, offset: number) {
        const where: any = {};
        if (filters.action) where.action = filters.action;
        if (filters.target_type) where.target_type = filters.target_type;
        if (filters.admin_id !== undefined) where.admin_id = filters.admin_id;

        const rows = await AuditLog.findAll({
            where,
            include: [{ model: User, attributes: ['username'] }],
            order: [['created_at', 'DESC']],
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

    async count_filtered(filters: { action?: string; target_type?: string; admin_id?: string }): Promise<number> {
        const where: any = {};
        if (filters.action) where.action = filters.action;
        if (filters.target_type) where.target_type = filters.target_type;
        if (filters.admin_id !== undefined) where.admin_id = filters.admin_id;
        return AuditLog.count({ where });
    }
}
