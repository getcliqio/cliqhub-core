/**
 * Hugs — requests for input from people (PLAN-hug-requests §6.3), asked in getHugs (PLAN-gethugs-integration.md).
 *
 *   POST /v1/hugs/create      cliqd opens a Hug for a phase
 *   POST /v1/hugs/close       cliqd (the requester) ends it with an outcome
 *   POST /v1/hugs/get_events  cliqd catches up on its Hugs' events
 *   POST /v1/hugs/get         a run's Hugs
 *   POST /v1/hugs/get_by_id   one Hug with its responses
 *   POST /v1/hugs/create_sign_in_link  a person's link into getHugs
 *
 * People answer in getHugs.
 */

import { BaseController } from './base_controller.js';
import { ApiError } from '../lib/api_error.js';
import { HugsService } from '../services/hugs.service.js';
import { gethugs_sign_in_link } from '../services/gethugs_sign_in.js';
import { gethugs_unanswered } from '../services/gethugs_unanswered.js';
import { RealmService } from '../services/realm.service.js';
import { Run } from '../models/index.js';
import type { FlatApiOkResponse, FlatApiRequest } from '../types/api_response.js';
import {
    HugsCloseInput,
    HugsCreateInput,
    HugsCreateSignInLinkInput,
    HugsGetByIdInput,
    HugsGetEventsInput,
    HugsGetInput,
} from '../schemas/hug_types.js';

type HugsFields = Record<string, unknown>;

/** `/v1/hugs/*`. */
export class HugsController extends BaseController {
    /**
     * POST /v1/hugs/create — open a Hug. The run must live in the realm, and a daemon token may
     * only name a daemon of that realm. Only such a daemon may send the hug's bundle.
     *
     * @param req - Body: {@link HugsCreateInput}
     * @param res - 201 `{ ok: true, data: { hug_id, hug_url } }`; 422 `unknown_hug` — no bundle hash and not a getHugs
     *   built-in; 409 `BUNDLE_MISSING` `{ sha256 }` — retry with `bundle`; 422 `BUNDLE_INVALID` `{ problems }`;
     *   403 `BUNDLE_REJECTED`
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
            bundle: body.bundle?.files,
            may_upload_bundle: req.auth?.auth_via === 'daemon_token',
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
     * POST /v1/hugs/get — a run's Hugs (every round, oldest first).
     *
     * @param req - Body: {@link HugsGetInput}
     * @param res - `{ ok: true, data: { items, total, offset, limit } }`
     */
    async get(req: FlatApiRequest<HugsGetInput, HugsFields>, res: FlatApiOkResponse<HugsFields>): Promise<void> {
        const user_id = req.auth?.user?.id?.trim();
        if (!user_id) throw ApiError.unauthorized('Authentication required');
        const body = this.parse_body(HugsGetInput, req);
        if (body.unanswered) {
            // From getHugs: the caller's unanswered Hugs in the org (the HUGs badge); never fails on getHugs' side.
            const w = await gethugs_unanswered({ user_id, org_id: body.org_id!, limit: body.limit });
            res.json({ ok: true, data: { items: w.items, total: w.total, offset: 0, limit: w.items.length, in_gethugs: w.in_gethugs, ...(w.stale ? { stale: true } : {}) } });
            return;
        }
        const result = await HugsService.list_for_run({ user_id, run_id: body.run_id!, statuses: body.statuses, limit: body.limit, offset: body.offset });
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
     * POST /v1/hugs/create_sign_in_link — a link (60 s, once) that signs the caller in to getHugs and lands on a Hug
     * (`hug_id`) or their getHugs inbox (`org_id`). People only, never daemons.
     *
     * @param req - Body: {@link HugsCreateSignInLinkInput}
     * @param res - `{ ok: true, data: { url } }`; 409 `not_in_gethugs` (use the plain link)
     */
    async create_sign_in_link(req: FlatApiRequest<HugsCreateSignInLinkInput, HugsFields>, res: FlatApiOkResponse<HugsFields>): Promise<void> {
        const user_id = req.auth?.user?.id?.trim();
        if (!user_id || req.auth?.auth_via === 'daemon_token') throw ApiError.unauthorized('A person signs in, with their own session');
        const body = this.parse_body(HugsCreateSignInLinkInput, req);
        const data = await gethugs_sign_in_link({ user_id, hug_id: body.hug_id, org_id: body.org_id, return_url: body.return_url });
        res.json({ ok: true, data });
    }
}
