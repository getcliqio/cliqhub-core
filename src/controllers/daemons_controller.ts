/**
 * Daemons Hub resource — DAE-ORG invent + DAE-S0 MVC structure.
 *
 * POST /v1/daemons/get: body `org_id` required unless `realm_id`.
 * Never invent org from X-Org-Id / current_org_id.
 * Envelope stays flat until a future DAE-ENV slice.
 */

import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import { DaemonService } from '../services/daemon.service.js';
import { RealmService } from '../services/realm.service.js';
import { resolve_enroll_realm_and_grant } from '../lib/enroll_grant.js';
import { assert_access, assert_realm_domain } from '../auth/assert_grant.js';
import { ApiError as HubApiError } from '../errors/api_error.js';
import { ApiError } from '../lib/api_error.js';
import { Realm } from '../models/index.js';
import type { AuthContext } from '../types/vo.js';
import type { FlatApiOkResponse, FlatApiRequest } from '../types/api_response.js';
import {
    DaemonDeregisterInput,
    DaemonGetByIdInput,
    DaemonGetInput,
    DaemonHeartbeatInput,
    DaemonRegisterInput,
    DaemonRemoveInput,
} from '../schemas/daemons/inputs.js';

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

/** Map HubApiError to flat `{ ok: false, error }` (daemon write paths). */
function respond_hub_error(err: unknown, res: Response): boolean {
    if (!(err instanceof HubApiError)) return false;
    res.status(err.status).json({ ok: false, error: err.message });
    return true;
}

type DaemonFields = Record<string, unknown>;

export class DaemonController extends BaseController {
    /**
     * Bearer must be allowed to act on `org_id`.
     * PAT/session: org_id ∈ auth.org_ids. Daemon token: realm.org_id === org_id.
     * Site hub admin may act on any org_id.
     */
    private async assert_org_authorized(auth: AuthContext | undefined, org_id: string): Promise<void> {
        // No credential context — refuse rather than invent tenancy.
        if (!auth) {
            throw ApiError.unauthorized('authentication required');
        }

        // Site admin may target any org.
        if (auth.user?.role === 'admin') return;

        // Daemon tokens are realm-bound; tenancy is the realm's org.
        if (auth.auth_via === 'daemon_token') {
            if (!auth.realm_id) {
                throw ApiError.forbidden('daemon token has no realm binding');
            }
            const realm = await Realm.findByPk(auth.realm_id);
            if (!realm || realm.org_id !== org_id) {
                throw ApiError.forbidden('org_id does not match daemon realm organization');
            }
            return;
        }

        // PAT / session: live membership list from auth middleware.
        if (!auth.org_ids.includes(org_id)) {
            throw ApiError.forbidden('not a member of the requested organization');
        }
    }

    private auth_from(req: Request): AuthContext | undefined {
        return req.auth;
    }

    async register(
        req: FlatApiRequest<DaemonRegisterInput, DaemonFields>,
        res: FlatApiOkResponse<DaemonFields>,
    ): Promise<void> {
        try {
            require_daemon_auth(req);
            assert_access(req.auth, 'daemons', 'write');

            const api_key = bearer_plaintext(req);
            if (!api_key) {
                res.status(401).json({ ok: false, error: 'Missing or invalid Authorization header' } as never);
                return;
            }

            const body = this.parse_body(DaemonRegisterInput, req);
            let enroll: ReturnType<typeof resolve_enroll_realm_and_grant>;
            try {
                enroll = resolve_enroll_realm_and_grant({
                    token_permissions: req.auth!.token_permissions as Record<string, unknown> | undefined,
                    auth_realm_id: req.auth!.realm_id,
                    requested_realm_id: typeof body.realm_id === 'string' ? body.realm_id : undefined,
                });
            } catch (err) {
                res.status(403).json({
                    ok: false,
                    error: err instanceof Error ? err.message : 'Realm grant denied',
                } as never);
                return;
            }

            assert_realm_domain(req.auth!, enroll.realm_id);

            const result = await DaemonService.register(api_key, {
                user_id: String(req.auth!.user!.id),
                user_email: req.auth!.user!.email,
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
            if (respond_hub_error(err, res)) return;
            throw err;
        }
    }

    async heartbeat(
        req: FlatApiRequest<DaemonHeartbeatInput, DaemonFields>,
        res: FlatApiOkResponse<DaemonFields>,
    ): Promise<void> {
        try {
            require_daemon_auth(req);
            assert_access(req.auth, 'daemons', 'write');

            const { daemon_id } = this.parse_body(DaemonHeartbeatInput, req);
            const realm_id = req.auth!.realm_id;
            if (!realm_id) {
                res.status(403).json({ ok: false, error: 'Daemon token has no primary realm' } as never);
                return;
            }
            assert_realm_domain(req.auth!, realm_id);
            await RealmService.assert_daemon_in_realm(realm_id, daemon_id);
            await DaemonService.heartbeat(daemon_id);

            // Heartbeat is pure liveness — team roster sync is handled by
            // the outbox protocol. No state payload processed here.
            res.json({ ok: true });
        } catch (err) {
            if (respond_hub_error(err, res)) return;
            throw err;
        }
    }

    async deregister(
        req: FlatApiRequest<DaemonDeregisterInput, DaemonFields>,
        res: FlatApiOkResponse<DaemonFields>,
    ): Promise<void> {
        try {
            require_daemon_auth(req);
            assert_access(req.auth, 'daemons', 'write');

            const { daemon_id } = this.parse_body(DaemonDeregisterInput, req);
            const realm_id = req.auth!.realm_id;
            if (!realm_id) {
                res.status(403).json({ ok: false, error: 'Daemon token has no primary realm' } as never);
                return;
            }
            assert_realm_domain(req.auth!, realm_id);
            await RealmService.assert_daemon_in_realm(realm_id, daemon_id);
            await DaemonService.deregister(daemon_id);
            res.json({ ok: true });
        } catch (err) {
            if (respond_hub_error(err, res)) return;
            throw err;
        }
    }

    /**
     * POST /v1/daemons/get — list daemons.
     * Org-scoped list requires body `org_id` (DAE-ORG hard-cut).
     */
    async get(
        req: FlatApiRequest<DaemonGetInput, DaemonFields>,
        res: FlatApiOkResponse<DaemonFields>,
    ): Promise<void> {
        // Zod SoT — org-scoped list requires org_id; never invent from X-Org-Id.
        const filters = this.parse_body(DaemonGetInput, req);
        let org_id: string | undefined;
        if (filters.org_id) {
            await this.assert_org_authorized(this.auth_from(req), filters.org_id);
            org_id = filters.org_id;
        }
        const result = await DaemonService.list(req.user?.user_id, {
            ...filters,
            org_id,
        });
        res.json({
            ok: true,
            daemons: result.daemons,
            total: result.total,
            offset: filters.offset ?? 0,
            limit: filters.limit ?? result.total,
        });
    }

    async get_by_id(
        req: FlatApiRequest<DaemonGetByIdInput, DaemonFields>,
        res: FlatApiOkResponse<DaemonFields>,
    ): Promise<void> {
        const { daemon_id } = this.parse_body(DaemonGetByIdInput, req);
        const user_id = req.user?.user_id;
        if (user_id) {
            await RealmService.assert_user_can_access_daemon(user_id, daemon_id);
        }
        const daemon = await DaemonService.get(daemon_id);
        res.json({ ok: true, daemon });
    }

    /** Remove a daemon from the registry (user-initiated cleanup). */
    async remove(
        req: FlatApiRequest<DaemonRemoveInput, DaemonFields>,
        res: FlatApiOkResponse<DaemonFields>,
    ): Promise<void> {
        const { daemon_id } = this.parse_body(DaemonRemoveInput, req);
        const user_id = req.user?.user_id;
        if (user_id) {
            await RealmService.assert_user_can_access_daemon(user_id, daemon_id);
        }
        await DaemonService.remove(daemon_id);
        res.json({ ok: true });
    }
}
