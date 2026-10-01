import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { RealmDispatchKeyService } from '../services/realm_dispatch_key.service.js';
import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';

const keys_body_schema = z.object({
    realm_id: z.string().min(1),
});

function assert_user(req: Request): { user_id: string } {
    if (!req.auth?.user?.id) throw ApiError.forbidden('Not authenticated');
    return { user_id: req.auth!.user!.id };
}

const log = get_logger('ctrl.realm_dispatch_key');

/** Hub→daemon wire key HTTP — POST /v1/auth/get_dispatch_public_key|rotate_dispatch_key. */
export class RealmDispatchKeyController {
    static async get_dispatch_public_key(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            log.debug('get_dispatch_public_key', { user_id: user.user_id, realm_id: req.body?.realm_id });
            const body = keys_body_schema.parse(req.body ?? {});
            // Route policy: realm view.
            const realm_id = body.realm_id.trim();
            const result = await RealmDispatchKeyService.get_or_create_public_key(realm_id);
            res.json({
                ok: true,
                realm_id: result.realm_id,
                public_key_pem: result.public_key_pem,
                created_at: result.created_at,
                rotated_at: result.rotated_at,
            });
        } catch (err) {
            next(err);
        }
    }

    static async rotate_dispatch_key(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            log.debug('rotate_dispatch_key', { user_id: user.user_id, realm_id: req.body?.realm_id });
            const body = keys_body_schema.parse(req.body ?? {});
            // Route policy: realm admin + dispatch_keys.manage.
            const realm_id = body.realm_id.trim();
            const result = await RealmDispatchKeyService.regenerate(realm_id);
            log.info('dispatch_key_rotated', { realm_id });
            res.json({
                ok: true,
                realm_id: result.realm_id,
                public_key_pem: result.public_key_pem,
                created_at: result.created_at,
                rotated_at: result.rotated_at,
            });
        } catch (err) {
            next(err);
        }
    }
}
