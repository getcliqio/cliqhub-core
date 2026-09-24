/**
 * Realm Hub resource — hard-cut surface (no aliases).
 *
 * Keep: get, get_by_id, create, update, delete,
 *       get_members, add_member, remove_member,
 *       add_team, remove_team.
 *
 * Lookup: get_by_id accepts realm_id OR { org_slug, slug }.
 * Teams roster reads live under POST /v1/teams/get { realm_id }.
 * Invite search lives under POST /v1/users/get { realm_id }.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

import { ApiError } from '../lib/api_error.js';
import { RealmService } from '../services/realm.service.js';
import { RealmTeamListService } from '../services/realm_team_list.service.js';
import { DispatchService } from '../services/dispatch.service.js';

function assert_user(req: Request): { user_id: string; email: string; current_org_id?: string; scope_ids?: string[]; org_ids?: string[] } {
    if (!req.user) throw ApiError.forbidden('Not authenticated');
    return {
        user_id: req.user.user_id,
        email: req.user.email ?? '',
        current_org_id: req.user.current_org_id,
        scope_ids: req.user.scope_ids,
        org_ids: req.user.org_ids,
    };
}

/** Verify that a realm belongs to the caller's active org when one is set. */
async function assert_realm_in_org(realm_id: string, current_org_id: string | undefined): Promise<void> {
    if (!current_org_id) return;
    const { Realm } = await import('../models/index.js');
    const realm = await Realm.findByPk(realm_id, { attributes: ['org_id'] });
    if (!realm) return;
    if (realm.org_id === current_org_id) return;
    throw ApiError.forbidden('Realm does not belong to the active org');
}

const create_schema = z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
});

const get_schema = z.object({
    slug: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    owned: z.enum(['me', 'default']).optional(),
    org_id: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
    sort_by: z.enum(['slug', 'name', 'created_at', 'updated_at', 'created_by']).optional(),
    sort_dir: z.enum(['asc', 'desc']).optional(),
}).optional();

/** Single-realm load: uuid id, or org-scoped slug. */
const get_by_id_schema = z.object({
    realm_id: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    org_slug: z.string().min(1).optional(),
}).superRefine((val, ctx) => {
    if (val.realm_id) return;
    if (val.slug) return;
    ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'realm_id or slug is required',
        path: ['realm_id'],
    });
});

const update_schema = z.object({
    realm_id: z.string().min(1),
    name: z.string().min(1).optional(),
});

const delete_schema = z.object({
    realm_id: z.string().min(1),
});

const get_members_schema = z.object({
    realm_id: z.string().min(1),
    member_type: z.enum(['user', 'daemon', 'group']).optional(),
});

const add_member_schema = z.object({
    realm_id: z.string().min(1),
    member_type: z.enum(['user', 'daemon', 'group']).default('user'),
    /** Hub user id when member_type=user; daemon/group id otherwise. */
    member_id: z.string().min(1),
    role: z.enum(['admin', 'operator', 'member']).optional(),
});

const remove_member_schema = z.object({
    realm_id: z.string().min(1),
    member_type: z.enum(['user', 'daemon', 'group']).default('user'),
    member_id: z.string().min(1),
});

const team_ref_schema = z.object({
    realm_id: z.string().min(1),
    scope: z.string().min(1),
    slug: z.string().min(1),
});

export class RealmController {
    static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = create_schema.parse(req.body ?? {});
            const realm = await RealmService.create(user.user_id, body.slug, body.name, {
                org_id: user.current_org_id,
            });
            res.json({ ok: true, realm });
        } catch (err) {
            next(err);
        }
    }

    static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = get_schema.parse(req.body ?? {});
            /** Omitted org_id = list across every org the user belongs to. */
            const org_id = body?.org_id != null ? String(body.org_id) : undefined;
            const { realms, total } = await RealmService.list_for_user(user.user_id, {
                slug: body?.slug,
                query: body?.query,
                owned: body?.owned,
                org_id,
                limit: body?.limit,
                offset: body?.offset,
                sort_by: body?.sort_by,
                sort_dir: body?.sort_dir,
            });
            res.json({ ok: true, realms, total });
        } catch (err) {
            next(err);
        }
    }

    static async get_by_id(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = get_by_id_schema.parse(req.body ?? {});

            if (body.realm_id) {
                await assert_realm_in_org(body.realm_id, user.current_org_id);
                const realm = await RealmService.get(body.realm_id, user.user_id);
                res.json({ ok: true, realm });
                return;
            }

            /** Slug path: resolve org then load by (org_id, slug). */
            let org_id = user.current_org_id;
            if (body.org_slug) {
                const { Org } = await import('../db/models/index.js');
                const org = await Org.findOne({ where: { slug: body.org_slug } });
                if (!org) throw ApiError.not_found('Org not found');
                org_id = org.id;
            }

            const realm = await RealmService.get_by_slug(
                body.slug!,
                user.user_id,
                { org_id },
            );
            res.json({ ok: true, realm });
        } catch (err) {
            next(err);
        }
    }

    static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = update_schema.parse(req.body ?? {});
            await assert_realm_in_org(body.realm_id, user.current_org_id);
            const realm = await RealmService.update(body.realm_id, user.user_id, { name: body.name });
            res.json({ ok: true, realm });
        } catch (err) {
            next(err);
        }
    }

    static async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = delete_schema.parse(req.body ?? {});
            await assert_realm_in_org(body.realm_id, user.current_org_id);
            await RealmService.remove(body.realm_id, user.user_id);
            res.json({ ok: true });
        } catch (err) {
            next(err);
        }
    }

    static async get_members(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = get_members_schema.parse(req.body ?? {});
            const members = await RealmService.list_members(
                body.realm_id,
                user.user_id,
                body.member_type,
            );
            res.json({ ok: true, members });
        } catch (err) {
            next(err);
        }
    }

    static async add_member(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = add_member_schema.parse(req.body ?? {});

            if (body.member_type === 'daemon') {
                throw ApiError.bad_request(
                    'Daemon membership is via realm token enroll (auth generate_token type=realm)',
                );
            }

            let member_id = body.member_id;
            if (body.member_type === 'user') {
                member_id = await RealmService.resolve_user_member_id(body.member_id);
            }

            const member = await RealmService.add_member(body.realm_id, user.user_id, {
                member_type: body.member_type,
                member_id,
                role: body.role,
            });
            res.json({ ok: true, member });
        } catch (err) {
            next(err);
        }
    }

    static async remove_member(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = remove_member_schema.parse(req.body ?? {});

            let member_id = body.member_id;
            if (body.member_type === 'user') {
                member_id = await RealmService.resolve_user_member_id(body.member_id);
            }

            await RealmService.remove_member(
                body.realm_id,
                user.user_id,
                body.member_type,
                member_id,
            );
            res.json({ ok: true });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Add team to the realm set and enqueue install to online daemons (outbox).
     */
    static async add_team(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = team_ref_schema.parse(req.body ?? {});
            const entry = { scope: body.scope, slug: body.slug };

            const team_list = await RealmTeamListService.add(body.realm_id, user.user_id, entry);
            const fanout = await RealmTeamListService.sync_team(
                body.realm_id,
                user.user_id,
                entry,
                user.scope_ids,
                user.org_ids,
            );

            res.json({ ok: true, team_list, install: fanout });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Remove team from the realm set and enqueue uninstall to online daemons (outbox).
     */
    static async remove_team(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const user = assert_user(req);
            const body = team_ref_schema.parse(req.body ?? {});
            const entry = { scope: body.scope, slug: body.slug };

            const team_list = await RealmTeamListService.remove(body.realm_id, user.user_id, entry);
            const uninstall = await DispatchService.uninstall_team({
                scope: entry.scope,
                slug: entry.slug,
                realm_id: body.realm_id,
                user_id: user.user_id,
                org_ids: user.org_ids,
            });

            res.json({ ok: true, team_list, uninstall });
        } catch (err) {
            next(err);
        }
    }
}
