import { z } from 'zod';
import { SortDirField, sort_by_field } from '../lib/list_sort.js';

export const reports_audit_schema = z.object({
    action: z.string().optional(),
    target_type: z.string().optional(),
    admin_id: z.string().uuid().optional(),
    /** Exact target id (user id, org slug, team id, agent id, …). */
    target_id: z.string().min(1).max(200).optional(),
    /** Entries at or after this time (epoch ms). */
    since_ms: z.number().int().min(0).optional(),
    /** Entries before this time (epoch ms). */
    until_ms: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
    sort_by: sort_by_field(['created_at', 'action'], 'newest first'),
    sort_dir: SortDirField,
});


/**
 * Canonical wire shape for an admin audit log entry.
 * Replaces inline shapes in reports_controller.ts, BFF AuditLog VO/DTO, and SPA AuditEntry.
 */
export const AuditLogData = z.object({
    id: z.string().uuid()
        .describe('Audit log entry UUID'),
    admin_id: z.string().uuid()
        .describe('UUID of the admin who performed the action'),
    admin_username: z.string().nullable()
        .describe('Username of the admin; null if account deleted'),
    action: z.string()
        .describe('Action slug (e.g. "org.delete", "user.suspend")'),
    target_type: z.string()
        .describe('Resource type the action was applied to'),
    target_id: z.string()
        .describe('ID of the affected resource'),
    details: z.record(z.unknown())
        .describe('Structured details of the action (parsed from stored JSON)'),
    created_at: z.string()
        .describe('ISO timestamp of the audit event'),
});

export type AuditLogData = z.infer<typeof AuditLogData>;
