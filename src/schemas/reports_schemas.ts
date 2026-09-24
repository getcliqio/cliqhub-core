import { z } from 'zod';

export const reports_audit_schema = z.object({
    action: z.string().optional(),
    target_type: z.string().optional(),
    admin_id: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
});
