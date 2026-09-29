import { z } from 'zod';

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
