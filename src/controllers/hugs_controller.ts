/**
 * Hugs — requests for input from people (PLAN-hug-requests §6.3).
 *
 *   POST /v1/hugs/create      cliqd opens a Hug for a phase
 *   POST /v1/hugs/close       cliqd (the requester) ends it with an outcome
 *   POST /v1/hugs/get_events  cliqd catches up on its Hugs' events
 *   POST /v1/hugs/get         a person's Hugs (inbox)
 *   POST /v1/hugs/get_by_id   one Hug with its responses
 *   POST /v1/hugs/respond     a person submits or replaces their response
 *
 * Files for `file` inputs are uploaded through `/v1/artifacts/upload` (§6.6). There is no chat.
 */

import { BaseController } from './base_controller.js';
import { get_logger } from '../lib/log.js';
import { ApiError } from '../lib/api_error.js';
import { HugsService } from '../services/hugs.service.js';
import { HugPendingService } from '../services/hug_pending.service.js';
import { RealmService } from '../services/realm.service.js';
import { Run } from '../models/index.js';
import type { FlatApiOkResponse, FlatApiRequest } from '../types/api_response.js';
import {
    HugsCloseInput,
    HugsCreateInput,
    HugsGetByIdInput,
    HugsGetEventsInput,
    HugsGetInput,
    HugsRespondInput,
} from '../schemas/hug_types.js';

type HugsFields = Record<string, unknown>;

const log = get_logger('ctrl.hugs');

/** `/v1/hugs/*`. */
export class HugsController extends BaseController {
    /**
     * POST /v1/hugs/create — open a Hug. The run must live in the realm, and a daemon token may
     * only name a daemon of that realm.
     *
     * @param req - Body: {@link HugsCreateInput}
     * @param res - 201 `{ ok: true, data: { hug_id, hug_url } }`
     */
    async create(req: FlatApiRequest<HugsCreateInput, HugsFields>, res: FlatApiOkResponse<HugsFields>): Promise<void> {
        const body = this.parse_body(HugsCreateInput, req);
        const run = await Run.findOne({ where: { run_id: body.run_id }, attributes: ['realm_id'], raw: true }) as { realm_id: string | null } | null;
        if (!run || run.realm_id !== body.realm_id) throw ApiError.not_found('Run not found in this realm');
        if (req.auth?.auth_via === 'daemon_token') await RealmService.assert_daemon_in_realm(body.realm_id, body.daemon_id);

        const data = await HugsService.create({
            hug_id: body.hug_id,
            run_id: body.run_id,
            daemon_id: body.daemon_id,
            realm_id: body.realm_id,
            phase: body.phase,
            iteration: body.iteration,
            spec: body.spec,
            actor_id: req.auth?.user?.id ?? null,
        });
        res.status(201).json({ ok: true, data });
    }

    /**
     * POST /v1/hugs/close — the requester ends its Hug. The daemon names itself (a daemon token is
     * scoped to a realm, not a daemon): it must be in the token's realm and have opened the Hug.
     *
     * @param req - Body: {@link HugsCloseInput}
     * @param res - `{ ok: true, data: { status } }`
     */
    async close(req: FlatApiRequest<HugsCloseInput, HugsFields>, res: FlatApiOkResponse<HugsFields>): Promise<void> {
        const body = this.parse_body(HugsCloseInput, req);
        if (!req.auth?.realm_id) throw ApiError.forbidden('Daemon token has no realm');
        await RealmService.assert_daemon_in_realm(req.auth.realm_id, body.daemon_id);
        const data = await HugsService.close(body);
        res.json({ ok: true, data });
    }

    /**
     * POST /v1/hugs/get_events — a daemon's catch-up (its own Hugs only).
     *
     * @param req - Body: {@link HugsGetEventsInput}
     * @param res - `{ ok: true, data: { events, hugs, has_more } }`
     */
    async get_events(req: FlatApiRequest<HugsGetEventsInput, HugsFields>, res: FlatApiOkResponse<HugsFields>): Promise<void> {
        const body = this.parse_body(HugsGetEventsInput, req);
        if (!req.auth?.realm_id) throw ApiError.forbidden('Daemon token has no realm');
        await RealmService.assert_daemon_in_realm(req.auth.realm_id, body.daemon_id);
        const data = await HugsService.get_events(body);
        res.json({ ok: true, data });
    }

    /**
     * POST /v1/hugs/get — the caller's Hugs.
     *
     * @param req - Body: {@link HugsGetInput}
     * @param res - `{ ok: true, data: { items, total, offset, limit } }`
     */
    async get(req: FlatApiRequest<HugsGetInput, HugsFields>, res: FlatApiOkResponse<HugsFields>): Promise<void> {
        const user_id = req.auth?.user?.id?.trim();
        if (!user_id) throw ApiError.unauthorized('Authentication required');
        const body = this.parse_body(HugsGetInput, req);
        const result = await HugPendingService.list_for_user({
            user_id, realm_id: body.realm_id, org_id: body.org_id, statuses: body.statuses, limit: body.limit, offset: body.offset,
        });
        res.json({ ok: true, data: { items: result.hugs, total: result.total, offset: body.offset ?? 0, limit: body.limit ?? 50 } });
    }

    /**
     * POST /v1/hugs/get_by_id — one Hug with its responses.
     *
     * @param req - Body: {@link HugsGetByIdInput}
     * @param res - `{ ok: true, data: HugData }`
     */
    async get_by_id(req: FlatApiRequest<HugsGetByIdInput, HugsFields>, res: FlatApiOkResponse<HugsFields>): Promise<void> {
        const body = this.parse_body(HugsGetByIdInput, req);
        const data = await HugsService.get(body.hug_id);
        res.json({ ok: true, data });
    }

    /**
     * POST /v1/hugs/respond — submit or replace the caller's response.
     *
     * @param req - Body: {@link HugsRespondInput}
     * @param res - `{ ok: true, data: { response_id, seq } }`
     */
    async respond(req: FlatApiRequest<HugsRespondInput, HugsFields>, res: FlatApiOkResponse<HugsFields>): Promise<void> {
        const user_id = req.auth?.user?.id?.trim();
        if (!user_id) throw ApiError.unauthorized('Authentication required');
        const body = this.parse_body(HugsRespondInput, req);
        const data = await HugsService.respond({ hug_id: body.hug_id, user_id, values: body.values, comment: body.comment });
        log.info('hug_response_submitted', { hug_id: body.hug_id });
        res.json({ ok: true, data });
    }
}
