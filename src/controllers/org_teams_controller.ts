/**
 * An org's team library (see OrgTeamsService).
 *
 *   POST /v1/orgs/get_teams    — teams in the org, with the realms that have each
 *   POST /v1/orgs/add_team     — add a team to the org
 *   POST /v1/orgs/remove_team  — remove a team no realm of the org has
 */
import type { Request, Response } from 'express';
import { BaseController } from './base_controller.js';
import { get_logger } from '../lib/log.js';
import { ApiError } from '../errors/api_error.js';
import { OrgTeamsService } from '../services/org_teams.service.js';
import { OrgsGetTeamsInput, OrgTeamRefInput } from '../schemas/org_types.js';

const log = get_logger('ctrl.org_teams');

export class OrgTeamsController extends BaseController {
    constructor(private readonly _svc: typeof OrgTeamsService = OrgTeamsService) {
        super();
    }

    private auth(req: Request) {
        if (!req.auth?.user) throw new ApiError('unauthorized', 'Authentication required', 401);
        return req.auth;
    }

    /** @param res - `{ ok: true, data: { items } }` */
    async get_teams(req: Request, res: Response): Promise<void> {
        this.auth(req);
        const body = this.parse_body(OrgsGetTeamsInput, req);
        this.ok(res, { items: await this._svc.list(body.org_id) });
    }

    /** @param res - `{ ok: true, data: { team_id, scope, name, added } }` */
    async add_team(req: Request, res: Response): Promise<void> {
        const auth = this.auth(req);
        const body = this.parse_body(OrgTeamRefInput, req);
        const r = await this._svc.add(auth, body.org_id, body);
        log.info('org_team_added', { org_id: body.org_id, team_id: r.team_id, added: r.added });
        this.ok(res, r);
    }

    /** @param res - `{ ok: true, data: { team_id, removed } }` */
    async remove_team(req: Request, res: Response): Promise<void> {
        const auth = this.auth(req);
        const body = this.parse_body(OrgTeamRefInput, req);
        const r = await this._svc.remove(auth, body.org_id, body);
        log.info('org_team_removed', { org_id: body.org_id, team_id: r.team_id, removed: r.removed });
        this.ok(res, r);
    }
}
