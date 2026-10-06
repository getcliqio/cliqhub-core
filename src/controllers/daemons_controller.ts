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
import { EnrollGrant } from '../lib/enroll_grant.js';
import { assert_access, assert_realm_domain } from '../auth/assert_grant.js';
import { ApiError as HubApiError } from '../errors/api_error.js';
import { ApiError } from '../lib/api_error.js';
import { AdminCheck } from '../lib/site_admin.js';
import { visible_realm_ids } from '../auth/route_policy/visible.js';
import type { FlatApiOkResponse, FlatApiRequest } from '../types/api_response.js';
import {
    DaemonDeregisterInput,
    DaemonGetByIdInput,
    DaemonGetInput,
    DaemonHeartbeatInput,
    DaemonRegisterInput,
    DaemonRegisterTeamsInput,
    DaemonRemoveInput,
} from '../schemas/daemon_types.js';
import { TeamService } from '../services/teams_install_service.js';
import { Realm } from '../models/index.js';
import { get_logger } from '../lib/log.js';

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

const log = get_logger('ctrl.daemons');

export class DaemonController extends BaseController {
    async register(
        req: FlatApiRequest<DaemonRegisterInput, DaemonFields>,
        res: FlatApiOkResponse<DaemonFields>,
    ): Promise<void> {
        try {
            log.debug('register', { realm_id: req.auth?.realm_id, daemon_id: (req.body as Record<string, unknown>)?.daemon_id });
            // Route policy: daemon token only.
            assert_access(req.auth, 'daemons', 'write');

            const api_key = bearer_plaintext(req);
            if (!api_key) {
                res.status(401).json({ ok: false, error: 'Missing or invalid Authorization header' } as never);
                return;
            }

            const body = this.parse_body(DaemonRegisterInput, req);
            let enroll: ReturnType<typeof EnrollGrant.resolve>;
            try {
                enroll = EnrollGrant.resolve({
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
            log.info('daemon_registered', { daemon_id: body.daemon_id, realm_id: enroll.realm_id });
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
            log.debug('heartbeat', { realm_id: req.auth?.realm_id, daemon_id: (req.body as Record<string, unknown>)?.daemon_id });
            // Route policy: daemon token only.
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

    /**
     * POST /v1/daemons/register_teams — settle the daemon's team ids: per team
     * the id it must use (an existing slot keeps its id; a new one takes the
     * daemon's). With `complete`, teams missing from the list are uninstalled.
     */
    async register_teams(req: Request, res: Response): Promise<void> {
        try {
            log.debug('register_teams', { realm_id: req.auth?.realm_id, daemon_id: (req.body as Record<string, unknown>)?.daemon_id });
            // Route policy: daemon token only.
            assert_access(req.auth, 'daemons', 'write');

            const { daemon_id, teams, complete } = this.parse_body(DaemonRegisterTeamsInput, req);
            const realm_id = req.auth!.realm_id;
            if (!realm_id) {
                res.status(403).json({ ok: false, error: 'Daemon token has no primary realm' });
                return;
            }
            assert_realm_domain(req.auth!, realm_id);
            await RealmService.assert_daemon_in_realm(realm_id, daemon_id);
            // Only teams on the realm's list may be on its daemons (PLAN-team-ids rule 7).
            const realm = await Realm.findByPk(realm_id, { attributes: ['team_list'] });
            const realm_teams = new Set(((realm?.team_list ?? []) as Array<{ scope: string; slug: string }>).map((e) => `${e.scope}/${e.slug}`));
            const settled = await TeamService.register_from_daemon(daemon_id, teams, Boolean(complete), realm_teams);
            log.info('daemon_teams_registered', { daemon_id, count: settled.length, complete: Boolean(complete) });
            res.json({ ok: true, data: { teams: settled } });
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
            log.debug('deregister', { realm_id: req.auth?.realm_id, daemon_id: (req.body as Record<string, unknown>)?.daemon_id });
            // Route policy: daemon token only.
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
            log.info('daemon_deregistered', { daemon_id });
            res.json({ ok: true });
        } catch (err) {
            if (respond_hub_error(err, res)) return;
            throw err;
        }
    }

    /**
     * POST /v1/daemons/get — list daemons.
     * Org-scoped list requires body `org_id` (DAE-ORG hard-cut).
     *
     * @param req - Body: {@link DaemonGetInput}
     * @param res - `{ ok: true, data: { items: DaemonFields[], total, offset, limit } }`
     */
    async get(
        req: FlatApiRequest<DaemonGetInput, DaemonFields>,
        res: FlatApiOkResponse<DaemonFields>,
    ): Promise<void> {
        // Zod SoT — org-scoped list requires org_id; never invent from X-Org-Id.
        const filters = this.parse_body(DaemonGetInput, req);
        log.debug('get', { org_id: filters.org_id, user_id: req.auth?.user?.id });
        const site_admin = filters.all === true && AdminCheck.is_site_admin(req);
        if (filters.all && !site_admin && !filters.org_id && !filters.realm_id?.trim()) {
            throw ApiError.unprocessable('org_id is required when listing daemons without realm_id', 'invalid_params');
        }
        let org_id: string | undefined;
        // Route policy: realm view + daemons.view, or org daemons.view.
        if (filters.org_id) org_id = filters.org_id;
        const { all: _all, ...rest } = filters;
        const result = await DaemonService.list(req.auth?.user?.id, {
            ...rest,
            org_id,
            ...(site_admin ? { site_admin: true } : {}),
        });
        res.json({
            ok: true,
            data: {
                items: result.daemons,
                total: result.total,
                offset: filters.offset ?? 0,
                limit: filters.limit ?? result.total,
            },
        });
    }

    async get_by_id(
        req: FlatApiRequest<DaemonGetByIdInput, DaemonFields>,
        res: FlatApiOkResponse<DaemonFields>,
    ): Promise<void> {
        const { daemon_id } = this.parse_body(DaemonGetByIdInput, req);
        log.debug('get_by_id', { daemon_id });
        // Route policy: view + daemons.view in a realm this daemon serves.
        const daemon = await DaemonService.get(daemon_id);
        res.json({ ok: true, daemon });
    }

    /** Remove a daemon from the registry (user-initiated cleanup). */
    async remove(
        req: FlatApiRequest<DaemonRemoveInput, DaemonFields>,
        res: FlatApiOkResponse<DaemonFields>,
    ): Promise<void> {
        const { daemon_id } = this.parse_body(DaemonRemoveInput, req);
        log.debug('remove', { daemon_id, user_id: req.auth?.user?.id });
        const user_id = req.auth?.user?.id;
        if (user_id && !AdminCheck.is_site_admin(req)) {
            await RealmService.assert_user_can_access_daemon(user_id, daemon_id);
            // Removing deletes the daemon for every realm it serves, so the caller
            // must be admin (with daemons.remove) in all of them (S16).
            const [daemon_realms, admin_realms] = await Promise.all([
                RealmService.list_realms_for_daemon(daemon_id),
                visible_realm_ids(String(user_id), { need: 'admin', perm: 'daemons.remove' }),
            ]);
            const blocked = daemon_realms.filter((r) => !admin_realms.includes(r.id));
            if (blocked.length > 0) {
                throw ApiError.forbidden('Realm admin (daemons.remove) required in every realm this daemon serves');
            }
        }
        await DaemonService.remove(daemon_id);
        log.info('daemon_removed', { daemon_id });
        res.json({ ok: true });
    }
}
