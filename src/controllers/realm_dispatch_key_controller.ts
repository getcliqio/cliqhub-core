import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { RealmDispatchKeyService } from '../services/realm_dispatch_key.service.js';
import { ApiError } from '../lib/api_error.js';

const keys_body_schema = z.object({
    realm_id: z.string().min(1),
});

function assert_user(req: Request): { user_id: string } {
    if (!req.user?.user_id) throw ApiError.forbidden('Not authenticated');
    return { user_id: String(req.user.user_id) };
}

/** Hub→daemon wire key HTTP — POST /v1/auth/get_dispatch_public_key|rotate_dispatch_key. */
export class RealmDispatchKeyController {
    static async get_dispatch_public_key(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = keys_body_schema.parse(req.body ?? {});
            const realm_id = await RealmDispatchKeyService.resolve_realm_id(user.user_id, body.realm_id, 'member');
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
            const body = keys_body_schema.parse(req.body ?? {});
            const realm_id = await RealmDispatchKeyService.resolve_realm_id(user.user_id, body.realm_id);
            const result = await RealmDispatchKeyService.regenerate(realm_id);
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
