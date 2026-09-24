/**
 * Realm A2A admin — single POST /v1/realms/a2a { action }.
 * Token mint/rotate lives under /v1/auth/* with type=a2a (not here).
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { RealmA2aService } from '../services/realm_a2a.service.js';
import { ApiError } from '../lib/api_error.js';

const a2a_schema = z.object({
    realm_id: z.string().min(1),
    action: z.enum(['get', 'update', 'mesh_connect', 'mesh_disconnect', 'mesh_refresh']),
    a2a_enabled: z.boolean().optional(),
    mesh_provider_mode: z.enum(['inherit', 'override', 'none']).optional(),
    active_provider_id: z.string().nullable().optional(),
    provider_id: z.string().optional(),
    provider_settings: z.record(z.unknown()).optional(),
});

function assert_user(req: Request): { user_id: string } {
    if (!req.user?.user_id) throw ApiError.forbidden('Not authenticated');
    return { user_id: String(req.user.user_id) };
}

export class RealmA2aController {
    static async list_adapters(_req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            res.json({ ok: true, adapters: RealmA2aService.list_adapters() });
        } catch (err) {
            next(err);
        }
    }

    /** Single A2A admin resource — action selects the operation. */
    static async handle(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = a2a_schema.parse(req.body ?? {});

            switch (body.action) {
                case 'get': {
                    const settings = await RealmA2aService.get_for_admin(body.realm_id, user.user_id);
                    res.json({ ok: true, ...settings });
                    return;
                }
                case 'update': {
                    const has_patch =
                        body.a2a_enabled !== undefined
                        || body.mesh_provider_mode !== undefined
                        || body.active_provider_id !== undefined
                        || (body.provider_id && body.provider_settings);
                    if (!has_patch) {
                        throw ApiError.bad_request('No settings fields to update');
                    }
                    const settings = await RealmA2aService.update_for_admin(body.realm_id, user.user_id, {
                        a2a_enabled: body.a2a_enabled,
                        mesh_provider_mode: body.mesh_provider_mode,
                        active_provider_id: body.active_provider_id,
                        provider_id: body.provider_id,
                        provider_settings: body.provider_settings,
                    });
                    res.json({ ok: true, ...settings });
                    return;
                }
                case 'mesh_connect': {
                    const settings = await RealmA2aService.connect_mesh(body.realm_id, user.user_id);
                    res.json({ ok: true, ...settings });
                    return;
                }
                case 'mesh_disconnect': {
                    const settings = await RealmA2aService.disconnect_mesh(body.realm_id, user.user_id);
                    res.json({ ok: true, ...settings });
                    return;
                }
                case 'mesh_refresh': {
                    const settings = await RealmA2aService.refresh_mesh(body.realm_id, user.user_id);
                    res.json({ ok: true, ...settings });
                    return;
                }
            }
        } catch (err) {
            next(err);
        }
    }
}
