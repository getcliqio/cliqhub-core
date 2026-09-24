/**
 * Controller for realm team list CRUD + apply.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { RealmTeamListService } from '../services/realm_team_list.service.js';
import { ApiError } from '../lib/api_error.js';

const team_entry = z.object({
    scope: z.string().min(1),
    slug: z.string().min(1),
});

const realm_id_schema = z.object({
    realm_id: z.string().min(1),
});

const set_schema = z.object({
    realm_id: z.string().min(1),
    teams: z.array(team_entry),
});

const add_schema = z.object({
    realm_id: z.string().min(1),
    scope: z.string().min(1),
    slug: z.string().min(1),
});

const remove_schema = z.object({
    realm_id: z.string().min(1),
    scope: z.string().min(1),
    slug: z.string().min(1),
});

const sync_schema = z.object({
    realm_id: z.string().min(1),
    scope: z.string().min(1),
    slug: z.string().min(1),
});

/** Extract authenticated user_id or throw. */
function require_user(req: Request): string {
    if (!req.user?.user_id) throw ApiError.forbidden('Not authenticated');
    return req.user.user_id;
}

export class RealmTeamListController {

    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { realm_id } = realm_id_schema.parse(req.body);
            const user_id = require_user(req);
            const team_list = await RealmTeamListService.get(realm_id, user_id);
            res.json({ ok: true, team_list });
        } catch (err) { next(err); }
    }

    static async set(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { realm_id, teams } = set_schema.parse(req.body);
            const user_id = require_user(req);
            const team_list = await RealmTeamListService.set(realm_id, user_id, teams);
            res.json({ ok: true, team_list });
        } catch (err) { next(err); }
    }

    static async add(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { realm_id, scope, slug } = add_schema.parse(req.body);
            const user_id = require_user(req);
            const team_list = await RealmTeamListService.add(realm_id, user_id, { scope, slug });
            res.json({ ok: true, team_list });
        } catch (err) { next(err); }
    }

    static async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { realm_id, scope, slug } = remove_schema.parse(req.body);
            const user_id = require_user(req);
            const team_list = await RealmTeamListService.remove(realm_id, user_id, { scope, slug });
            res.json({ ok: true, team_list });
        } catch (err) { next(err); }
    }

    static async apply(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { realm_id } = realm_id_schema.parse(req.body);
            const user_id = require_user(req);
            const results = await RealmTeamListService.apply(realm_id, user_id);
            res.json({ ok: true, results });
        } catch (err) { next(err); }
    }

    /** Force-overwrite one team-list entry onto all online realm daemons. */
    static async sync(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { realm_id, scope, slug } = sync_schema.parse(req.body);
            const user_id = require_user(req);
            const result = await RealmTeamListService.sync_team(
                realm_id,
                user_id,
                { scope, slug },
                req.user?.scope_ids,
                req.user?.org_ids,
            );
            res.json({ ok: true, result });
        } catch (err) { next(err); }
    }
}
