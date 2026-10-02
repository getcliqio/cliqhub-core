/**
 * Realm Hub resource — hard-cut surface (no aliases).
 *
 * Routes (1:1 with this controller):
 *   POST /v1/realms/create | get | get_by_id | update | delete
 *   POST /v1/realms/get_members | add_member | remove_member
 *   POST /v1/realms/add_team | remove_team
 *
 * Tenancy: body `org_id` on create / get filter / slug get_by_id.
 * Never invent org from X-Org-Id / current_org_id.
 * Mutations keyed by realm_id use RealmService membership (no header org gate).
 *
 * Lookup: get_by_id accepts realm_id XOR { slug, org_id } XOR { slug, org_slug }.
 * Teams roster reads live under POST /v1/teams/get { realm_id }.
 * Invite search lives under POST /v1/users/get { realm_id }.
 *
 * Request typing: `FlatApiRequest` / `FlatApiOkResponse` (flat `{ ok, realm }` until RM-ENV).
 * Inbound SoT: PascalCase Zod `Realm*Input` in `schemas/realms/types.ts`.
 */

import type { Request, Response } from 'express';

import { OrgTeamsService } from '../services/org_teams.service.js';
import { BaseController } from './base_controller.js';
import { get_logger } from '../lib/log.js';
import { ApiError } from '../lib/api_error.js';
import { AdminCheck } from '../lib/site_admin.js';
import { RealmService } from '../services/realm.service.js';
import { RealmTeamListService } from '../services/realm_team_list.service.js';
import { DispatchService } from '../services/dispatch.service.js';
import { RealmRepository } from '../repositories/realm_repository.js';

const _realm_repo_rc = new RealmRepository();
import { OrgRepository } from '../repositories/org_repository.js';

const _org_repo_rc = new OrgRepository();
import type { FlatApiOkResponse, FlatApiRequest } from '../types/api_response.js';
import type { Realm_dto } from '../services/realm.service.js';
import {
    RealmCreateInput,
    RealmGetInput,
    RealmGetByIdInput,
    RealmUpdateInput,
    RealmDeleteInput,
    RealmGetMembersInput,
    RealmAddMemberInput,
    RealmRemoveMemberInput,
    RealmTeamRefInput,
} from '../schemas/realm_types.js';

type Realm_user = {
    user_id: string;
    email: string;
    scope_ids?: string[];
    org_ids?: string[];
};

type Realm_one = { realm: Realm_dto };
type Realm_list = { realms: Realm_dto[]; total: number };
type Realm_members = { members: unknown };
type Realm_member_one = { member: unknown };
type Realm_team_add = { team_list: unknown; install: unknown };
type Realm_team_remove = { team_list: unknown; uninstall: unknown };

const log = get_logger('ctrl.realms');

/**
 * Flat response helpers (envelope { ok, data } deferred to RM-ENV).
 */
export class RealmController extends BaseController {
    constructor(
        private readonly _realm: typeof RealmService = RealmService,
        private readonly _team_list: typeof RealmTeamListService = RealmTeamListService,
        private readonly _dispatch: typeof DispatchService = DispatchService,
    ) {
        super();
    }

    private assert_user(req: Request): Realm_user {
        if (!req.auth?.user) {
            throw ApiError.forbidden('Not authenticated');
        }
        return {
            user_id: req.auth.user.id,
            email: req.auth.user.email ?? '',
            scope_ids: req.auth.scopes.map(s => s.id),
            org_ids: req.auth.org_ids,
        };
    }

    /**
     * Create a realm in the org named by body.org_id.
     *
     * @param req - Body: {@link RealmCreateInput}
     * @param res - Flat `{ ok: true, realm }`
     */
    async create(
        req: Request,
        res: Response,
    ): Promise<void> {
        const user = this.assert_user(req);
        log.debug('create', { user_id: user.user_id });
        // Zod SoT — org_id required; never invent from X-Org-Id.
        const body = this.parse_body(RealmCreateInput, req);
        // Route policy: realms.create in body.org_id.

        const realm = await this._realm.create(user.user_id, body.slug, body.name, {
            org_id: body.org_id,
        });
        log.info('realm_created', { id: realm.id });
        res.json({ ok: true, realm });
    }

    /**
     * List realms visible to the user (optional org_id filter).
     *
     * @param req - Body: {@link RealmGetInput}
     * @param res - `{ ok: true, data: { items, total, offset, limit } }`
     */
    async get(
        req: Request,
        res: Response,
    ): Promise<void> {
        const user = this.assert_user(req);
        log.debug('get', { user_id: user.user_id });
        // Empty / omitted body is valid — all fields optional.
        if (req.body == null || typeof req.body !== 'object') {
            (req as Request & { body: Record<string, unknown> }).body = {};
        }
        const body = this.parse_body(RealmGetInput, req);

        // `all` is honoured for site admins only (hub-wide Admin views).
        const site_admin = body.all === true && AdminCheck.is_site_admin(req);
        // Optional org filter: route policy checked membership of body.org_id.

        // Omitted org_id = list across every org the user belongs to.
        const { realms, total } = await this._realm.list_for_user(user.user_id, {
            slug: body.slug,
            query: body.query,
            owned: body.owned,
            org_id: body.org_id,
            limit: body.limit,
            offset: body.offset,
            sort_by: body.sort_by,
            sort_dir: body.sort_dir,
            ...(site_admin ? { site_admin: true } : {}),
        });
        res.json({
            ok: true,
            data: {
                items: realms,
                total,
                offset: body.offset ?? 0,
                limit: body.limit ?? 50,
            },
        });
    }

    /**
     * Load one realm by id or org-scoped slug.
     *
     * @param req - Body: {@link RealmGetByIdInput}
     * @param res - Flat `{ ok: true, realm }`
     */
    async get_by_id(
        req: Request,
        res: Response,
    ): Promise<void> {
        const user = this.assert_user(req);
        log.debug('get_by_id', { user_id: user.user_id });
        // Zod XOR — realm_id | (slug+org_id) | (slug+org_slug); bare slug rejected.
        const body = this.parse_body(RealmGetByIdInput, req);

        // UUID path — membership checked inside RealmService.get; no header org gate.
        if (body.realm_id) {
            const realm = await this._realm.get(body.realm_id, user.user_id);
            res.json({ ok: true, realm });
            return;
        }

        // Slug path — resolve org explicitly (never fall back to current_org_id).
        let org_id = body.org_id;
        if (body.org_slug) {
            const org = await _org_repo_rc.find_one_q({ where: { slug: body.org_slug } });
            if (!org) {
                throw ApiError.not_found('Org not found');
            }
            org_id = org.id;
        }
        // Refined schema should always yield org_id here; refuse closed if not.
        if (!org_id) {
            throw ApiError.bad_request('slug requires org_id or org_slug');
        }

        // Route policy resolved the realm by (org, slug) and checked realm view.
        const realm = await this._realm.get_by_slug(body.slug!, user.user_id, { org_id });
        res.json({ ok: true, realm });
    }

    /**
     * Rename a realm (membership / role via service).
     *
     * @param req - Body: {@link RealmUpdateInput}
     * @param res - Flat `{ ok: true, realm }`
     */
    async update(
        req: Request,
        res: Response,
    ): Promise<void> {
        const user = this.assert_user(req);
        log.debug('update', { user_id: user.user_id });
        // Zod SoT — realm_id + name; no body org_id required for mutations.
        const body = this.parse_body(RealmUpdateInput, req);
        // No header org gate — RealmService enforces caller may mutate this realm.
        const realm = await this._realm.update(body.realm_id, user.user_id, { name: body.name });
        log.info('realm_updated', { id: body.realm_id });
        res.json({ ok: true, realm });
    }

    /**
     * Soft-delete a realm.
     *
     * @param req - Body: {@link RealmDeleteInput}
     * @param res - Flat `{ ok: true }`
     */
    async delete(
        req: Request,
        res: Response,
    ): Promise<void> {
        const user = this.assert_user(req);
        log.debug('delete', { user_id: user.user_id });
        // Zod SoT — realm_id required; no body org_id / header gate.
        const body = this.parse_body(RealmDeleteInput, req);
        // Membership / role enforced in service (not ambient X-Org-Id).
        await this._realm.remove(body.realm_id, user.user_id);
        log.info('realm_deleted', { id: body.realm_id });
        res.json({ ok: true });
    }

    /**
     * List realm members.
     *
     * @param req - Body: {@link RealmGetMembersInput}
     * @param res - Flat `{ ok: true, members }`
     */
    async get_members(
        req: Request,
        res: Response,
    ): Promise<void> {
        const user = this.assert_user(req);
        log.debug('get_members', { user_id: user.user_id });
        // Zod SoT — realm_id + optional member_type filter.
        const body = this.parse_body(RealmGetMembersInput, req);
        // Caller must already be a realm member; service returns typed roster.
        const members = await this._realm.list_members(
            body.realm_id,
            user.user_id,
            body.member_type,
        );
        res.json({ ok: true, members });
    }

    /**
     * Add a user/group member (daemon enroll is via realm token).
     *
     * @param req - Body: {@link RealmAddMemberInput}
     * @param res - Flat `{ ok: true, member }`
     */
    async add_member(
        req: Request,
        res: Response,
    ): Promise<void> {
        const user = this.assert_user(req);
        log.debug('add_member', { user_id: user.user_id });
        const body = this.parse_body(RealmAddMemberInput, req);

        // Daemons join via enroll token — never via add_member.
        if (body.member_type === 'daemon') {
            throw ApiError.bad_request(
                'Daemon membership is via realm token enroll (auth generate_token type=realm)',
            );
        }

        // Users may be addressed by username/email; normalize to user UUID.
        let member_id = body.member_id;
        if (body.member_type === 'user') {
            member_id = await this._realm.resolve_user_member_id(body.member_id);
        }

        const member = await this._realm.add_member(body.realm_id, user.user_id, {
            member_type: body.member_type,
            member_id,
            role: body.role,
        });
        log.info('member_added', { realm_id: body.realm_id, member_id });
        res.json({ ok: true, member });
    }

    /**
     * Remove a realm member.
     *
     * @param req - Body: {@link RealmRemoveMemberInput}
     * @param res - Flat `{ ok: true }`
     */
    async remove_member(
        req: Request,
        res: Response,
    ): Promise<void> {
        const user = this.assert_user(req);
        log.debug('remove_member', { user_id: user.user_id });
        const body = this.parse_body(RealmRemoveMemberInput, req);

        // Same username/email → UUID resolve as add_member.
        let member_id = body.member_id;
        if (body.member_type === 'user') {
            member_id = await this._realm.resolve_user_member_id(body.member_id);
        }

        await this._realm.remove_member(
            body.realm_id,
            user.user_id,
            body.member_type,
            member_id,
        );
        log.info('member_removed', { realm_id: body.realm_id, member_id });
        res.json({ ok: true });
    }

    /**
     * Add team to the realm set and enqueue install to online daemons (outbox).
     *
     * @param req - Body: {@link RealmTeamRefInput}
     * @param res - Flat `{ ok: true, team_list, install }`
     */
    async add_team(
        req: Request,
        res: Response,
    ): Promise<void> {
        const user = this.assert_user(req);
        log.debug('add_team', { user_id: user.user_id });
        // Zod SoT — realm_id + published team scope/slug.
        const body = this.parse_body(RealmTeamRefInput, req);
        const entry = { scope: body.scope, slug: body.slug };

        // A team joins the realm's org before the realm (added to the org here when allowed).
        await OrgTeamsService.ensure_for_realm(req.auth!, body.realm_id, body.scope, body.slug);
        // Persist on realm.team_list first so list reads stay consistent.
        const team_list = await this._team_list.add(body.realm_id, user.user_id, entry);
        // Fan-out install commands to online daemons (outbox; may be empty).
        const fanout = await this._team_list.sync_team(
            body.realm_id,
            user.user_id,
            entry,
            user.scope_ids,
            user.org_ids,
        );

        log.info('team_added', { realm_id: body.realm_id, scope: body.scope, slug: body.slug });
        res.json({ ok: true, team_list, install: fanout });
    }

    /**
     * Remove team from the realm set and enqueue uninstall to online daemons (outbox).
     *
     * @param req - Body: {@link RealmTeamRefInput}
     * @param res - Flat `{ ok: true, team_list, uninstall }`
     */
    async remove_team(
        req: Request,
        res: Response,
    ): Promise<void> {
        const user = this.assert_user(req);
        log.debug('remove_team', { user_id: user.user_id });
        const body = this.parse_body(RealmTeamRefInput, req);
        const entry = { scope: body.scope, slug: body.slug };

        // Drop from realm set before daemon uninstall so Hub SoT is already clean.
        const team_list = await this._team_list.remove(body.realm_id, user.user_id, entry);
        // Best-effort uninstall on online daemons; failures surface in uninstall DTO.
        const uninstall = await this._dispatch.uninstall_team({
            scope: entry.scope,
            slug: entry.slug,
            realm_id: body.realm_id,
            user_id: user.user_id,
            org_ids: user.org_ids,
        });

        log.info('team_removed', { realm_id: body.realm_id, scope: body.scope, slug: body.slug });
        res.json({ ok: true, team_list, uninstall });
    }
}
