import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { DaemonService } from '../services/daemon.service.js';
import { RealmService } from '../services/realm.service.js';
import { resolve_enroll_realm_and_grant } from '../lib/enroll_grant.js';
import { assert_access, assert_realm_domain } from '../auth/assert_grant.js';
import { ApiError as HubApiError } from '../errors/api_error.js';

const heartbeat_schema = z.object({
    daemon_id: z.string(),
    // Legacy fields — heartbeat is pure liveness now, team roster
    // is synced via the outbox protocol and on-demand query.
    teams_hash: z.string().optional(),
    teams: z.array(z.unknown()).optional(),
});
const deregister_schema = z.object({ daemon_id: z.string() });
const get_schema = z.object({
    realm_id: z.string().optional(),
    status: z.enum(['online', 'stale', 'offline']).optional(),
    /** Substring match on daemon id / hostname (POST body only). */
    query: z.string().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
}).optional();

const get_by_id_schema = z.object({ daemon_id: z.string() });
const remove_schema = z.object({ daemon_id: z.string() });

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

function bearer_plaintext(req: Request): string {
    const auth_header = req.headers.authorization ?? '';
    if (!auth_header.startsWith('Bearer ')) return '';
    return auth_header.slice(7).trim();
}

function hub_error_to_response(err: unknown, res: Response, next: NextFunction): void {
    if (err instanceof HubApiError) {
        res.status(err.status).json({ ok: false, error: err.message });
        return;
    }
    next(err);
}

export class DaemonController {
    static async register(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            require_daemon_auth(req);
            assert_access(req.auth, 'daemons', 'write');

            const api_key = bearer_plaintext(req);
            if (!api_key) {
                res.status(401).json({ ok: false, error: 'Missing or invalid Authorization header' });
                return;
            }

            const body = req.body ?? {};
            let enroll: ReturnType<typeof resolve_enroll_realm_and_grant>;
            try {
                enroll = resolve_enroll_realm_and_grant({
                    token_permissions: req.auth.token_permissions as Record<string, unknown> | undefined,
                    auth_realm_id: req.auth.realm_id,
                    requested_realm_id: typeof body.realm_id === 'string' ? body.realm_id : undefined,
                });
            } catch (err) {
                res.status(403).json({
                    ok: false,
                    error: err instanceof Error ? err.message : 'Realm grant denied',
                });
                return;
            }

            assert_realm_domain(req.auth, enroll.realm_id);

            const result = await DaemonService.register(api_key, {
                user_id: String(req.auth.user!.id),
                user_email: req.auth.user!.email,
                realm_id: enroll.realm_id,
                permissions: enroll.permissions as unknown as Record<string, unknown>,
                daemon_id: body.daemon_id,
                hostname: body.hostname,
                ip: body.ip,
                port: body.port,
                public_url: body.public_url,
                name: body.name,
            });
            res.json({ ok: true, daemon: result });
        } catch (err) {
            hub_error_to_response(err, res, next);
        }
    }

    static async heartbeat(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            require_daemon_auth(req);
            assert_access(req.auth, 'daemons', 'write');

            const { daemon_id } = heartbeat_schema.parse(req.body);
            const realm_id = req.auth.realm_id;
            if (!realm_id) {
                res.status(403).json({ ok: false, error: 'Daemon token has no primary realm' });
                return;
            }
            assert_realm_domain(req.auth, realm_id);
            await RealmService.assert_daemon_in_realm(realm_id, daemon_id);
            await DaemonService.heartbeat(daemon_id);

            // Heartbeat is pure liveness — team roster sync is handled by
            // the outbox protocol. No state payload processed here.
            res.json({ ok: true });
        } catch (err) {
            hub_error_to_response(err, res, next);
        }
    }


    static async deregister(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            require_daemon_auth(req);
            assert_access(req.auth, 'daemons', 'write');

            const { daemon_id } = deregister_schema.parse(req.body);
            const realm_id = req.auth.realm_id;
            if (!realm_id) {
                res.status(403).json({ ok: false, error: 'Daemon token has no primary realm' });
                return;
            }
            assert_realm_domain(req.auth, realm_id);
            await RealmService.assert_daemon_in_realm(realm_id, daemon_id);
            await DaemonService.deregister(daemon_id);
            res.json({ ok: true });
        } catch (err) {
            hub_error_to_response(err, res, next);
        }
    }

    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const filters = get_schema.parse(req.body ?? {});
            const org_id = req.user?.current_org_id;
            const result = await DaemonService.list(req.user?.user_id, {
                ...filters,
                org_id,
            });
            res.json({
                ok: true,
                daemons: result.daemons,
                total: result.total,
                offset: filters?.offset ?? 0,
                limit: filters?.limit ?? result.total,
            });
        } catch (err) {
            next(err);
        }
    }

    static async get_by_id(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { daemon_id } = get_by_id_schema.parse(req.body);
            const user_id = req.user?.user_id;
            if (user_id) {
                await RealmService.assert_user_can_access_daemon(user_id, daemon_id);
            }
            const daemon = await DaemonService.get(daemon_id);
            res.json({ ok: true, daemon });
        } catch (err) {
            next(err);
        }
    }

    /** Remove a daemon from the registry (user-initiated cleanup). */
    static async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { daemon_id } = remove_schema.parse(req.body);
            const user_id = req.user?.user_id;
            if (user_id) {
                await RealmService.assert_user_can_access_daemon(user_id, daemon_id);
            }
            await DaemonService.remove(daemon_id);
            res.json({ ok: true });
        } catch (err) {
            next(err);
        }
    }
}
