import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import { build_daemon_acl_bundle } from '../services/daemon.service.js';
import { EnrollGrant } from '../lib/enroll_grant.js';
import { assert_access, assert_realm_domain } from '../auth/assert_grant.js';
import { ApiError as HubApiError } from '../errors/api_error.js';
import { get_logger } from '../lib/log.js';

const acl_schema = z.object({
    realm_id: z.string().min(1).optional(),
    daemon_id: z.string().min(1).optional(),
});

/**
 * POST /v1/auth/acl — daemon refreshes realm ACL + dispatch public key.
 * Authenticated with a realm enroll token (cliq_dt_…).
 */
const log = get_logger('ctrl.daemon_acl');

export class DaemonAclController {
    static async get_acl(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            log.debug('get_acl', { realm_id: req.auth?.realm_id, daemon_id: (req.body as Record<string, unknown>)?.daemon_id });
            // Route policy: daemon token only.
            assert_access(req.auth, 'daemons', 'write');

            const body = acl_schema.parse(req.body ?? {});
            let enroll: ReturnType<typeof EnrollGrant.resolve>;
            try {
                enroll = EnrollGrant.resolve({
                    token_permissions: req.auth.token_permissions as Record<string, unknown> | undefined,
                    auth_realm_id: req.auth.realm_id,
                    requested_realm_id: body.realm_id,
                });
            } catch (err) {
                res.status(403).json({
                    ok: false,
                    error: err instanceof Error ? err.message : 'Realm grant denied',
                    code: 'forbidden',
                });
                return;
            }

            assert_realm_domain(req.auth, enroll.realm_id);
            const acl = await build_daemon_acl_bundle(enroll.realm_id);
            res.json({
                ok: true,
                data: {
                    ...acl,
                    daemon_id: body.daemon_id,
                },
            });
        } catch (err) {
            if (err instanceof HubApiError) {
                res.status(err.status).json({ ok: false, error: err.message, code: err.code });
                return;
            }
            next(err);
        }
    }
}
