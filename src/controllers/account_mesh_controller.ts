import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { OrgMeshService } from '../services/org_mesh.service.js';
import { ApiError } from '../lib/api_error.js';
import { UserRepository } from '../repositories/user_repository.js';
import { get_logger } from '../lib/log.js';

const _user_repo_amc = new UserRepository();
import {
    ensure_personal_org_for_user,
    resolve_primary_org_id_for_user,
} from '../models/migrations/migrate_ensure_user_orgs.js';

const update_schema = z.object({
    active_provider_id: z.string().nullable().optional(),
    auto_enable_a2a_on_realm_create: z.boolean().optional(),
    provider_id: z.string().optional(),
    provider_settings: z.record(z.unknown()).optional(),
});

function assert_user(req: Request): { user_id: string } {
    if (!req.auth?.user?.id) throw ApiError.forbidden('Not authenticated');
    return { user_id: req.auth!.user!.id };
}

/**
 * Legacy account mesh endpoints — resolve the caller's personal/primary org
 * and delegate to OrgMeshService. Prefer /v1/orgs/mesh/* with explicit org_id.
 */
const log = get_logger('ctrl.account_mesh');

export class AccountMeshController {
    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            log.debug('get', { user_id: req.auth?.user?.id });
            const user = assert_user(req);
            const org_id = await resolve_org_for_user(user.user_id);
            const settings = await OrgMeshService.get_for_admin(org_id, user.user_id);
            res.json({ ok: true, ...settings });
        } catch (err) {
            next(err);
        }
    }

    static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            log.debug('update', { user_id: req.auth?.user?.id });
            const user = assert_user(req);
            const body = update_schema.parse(req.body ?? {});
            const org_id = await resolve_org_for_user(user.user_id);
            const settings = await OrgMeshService.update_for_admin(org_id, user.user_id, body);
            log.info('mesh_updated', { org_id });
            res.json({ ok: true, ...settings });
        } catch (err) {
            next(err);
        }
    }
}

async function resolve_org_for_user(user_id: string): Promise<string> {
    const user = await _user_repo_amc.find_by_id(user_id, { attributes: ['id', 'username'] });
    if (!user?.username) throw ApiError.forbidden('Not authenticated');

    let org_id = await resolve_primary_org_id_for_user(user.id, user.username);
    if (!org_id) {
        const org = await ensure_personal_org_for_user(user.id, user.username);
        org_id = org.id;
    }
    return org_id;
}
