import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import { build_daemon_acl_bundle } from '../services/daemon.service.js';
import { resolve_enroll_realm_and_grant } from '../lib/enroll_grant.js';
import { assert_access, assert_realm_domain } from '../auth/assert_grant.js';
import { ApiError as HubApiError } from '../errors/api_error.js';

const acl_schema = z.object({
    realm_id: z.string().min(1).optional(),
    daemon_id: z.string().min(1).optional(),
});

function require_daemon_auth(req: Request): void {
    if (!req.auth?.user) {
        throw new HubApiError('unauthorized', 'Unauthorized', 401);
    }
    if (req.auth.auth_via !== 'daemon_token') {
        throw new HubApiError(
            'forbidden',
            'Daemon token required — daemons cannot use a user credential here',
            403,
        );
    }
}

/**
 * POST /v1/auth/acl — daemon refreshes realm ACL + dispatch public key.
 * Authenticated with a realm enroll token (cliq_dt_…).
 */
export class DaemonAclController {
    static async get_acl(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            require_daemon_auth(req);
            assert_access(req.auth, 'daemons', 'write');

            const body = acl_schema.parse(req.body ?? {});
            let enroll: ReturnType<typeof resolve_enroll_realm_and_grant>;
            try {
                enroll = resolve_enroll_realm_and_grant({
                    token_permissions: req.auth.token_permissions as Record<string, unknown> | undefined,
                    auth_realm_id: req.auth.realm_id,
                    requested_realm_id: body.realm_id,
                });
            } catch (err) {
                res.status(403).json({
                    ok: false,
                    error: err instanceof Error ? err.message : 'Realm grant denied',
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
                res.status(err.status).json({ ok: false, error: err.message });
                return;
            }
            next(err);
        }
    }
}
