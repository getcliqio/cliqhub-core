import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { OrgMeshService } from '../services/org_mesh.service.js';
import { ApiError } from '../lib/api_error.js';

const org_id_schema = z.object({
    org_id: z.string().min(1),
});

const update_schema = z.object({
    org_id: z.string().min(1),
    active_provider_id: z.string().nullable().optional(),
    auto_enable_a2a_on_realm_create: z.boolean().optional(),
    provider_id: z.string().optional(),
    provider_settings: z.record(z.unknown()).optional(),
});

function assert_user(req: Request): { user_id: string } {
    if (!req.user?.user_id) throw ApiError.forbidden('Not authenticated');
    return { user_id: String(req.user.user_id) };
}

export class OrgMeshController {
    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = org_id_schema.parse(req.body ?? {});
            const settings = await OrgMeshService.get_for_admin(body.org_id, user.user_id);
            res.json({ ok: true, ...settings });
        } catch (err) {
            next(err);
        }
    }

    static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = update_schema.parse(req.body ?? {});
            const settings = await OrgMeshService.update_for_admin(body.org_id, user.user_id, body);
            res.json({ ok: true, ...settings });
        } catch (err) {
            next(err);
        }
    }
}
