import { ApiError } from '../errors/api_error.js';
import { get_logger } from '../lib/log.js';
import { RESERVED_SCOPES, SLUG_PATTERN } from '../config/env.js';
import type { AuditRepository } from '../repositories/audit_repository.js';
import type { AuthContext } from '../schemas/auth_types.js';
import { Op, col, fn, literal } from 'sequelize';
import { equals_first, list_order, type SortColumns, type SortDir } from '../lib/list_sort.js';
import {
    assert_namespace_free, deleted_user_error, namespace_conflict, namespace_holders, on_name_race, type NamespaceRepos,
} from '../lib/namespace.js';
import { normalize_email } from '../lib/account_fields.js';
import { get_sequelize } from '../db/sequelize.js';
import { AccountInvite, Org as OrgModel, User as UserModel } from '../models/index.js';
import type { OrgStatus } from '../models/org.model.js';
import { UserRepository, user_list_status, type UserListStatus } from '../repositories/user_repository.js';
import { ScopeRepository } from '../repositories/scope_repository.js';
import { OrgRepository } from '../repositories/org_repository.js';
import type { OrgMemberRepository } from '../repositories/org_member_repository.js';
import type { ScopeMemberRepository } from '../repositories/scope_member_repository.js';
import { TeamRepository } from '../repositories/team_repository.js';
import { seed_default_roles_for_org } from '../models/migrations/migrate_org_roles.js';
import { RealmService } from '../services/realm.service.js';
import { OrgRealmSyncService } from './org_realm_sync_service.js';
import { soft_delete_org } from './namespace_removal.js';
import { OrgSeedService } from './org_seed.service.js';
import type { InvitationsService } from './invitations_service.js';
import type { ReactivationService } from './reactivation.service.js';
import { escape_like } from '../lib/search.js';

const _user_repo_os = new UserRepository();
const _scope_repo_os = new ScopeRepository();
const _org_repo_os = new OrgRepository();
const _team_repo_os = new TeamRepository();

const log = get_logger('svc.orgs');

/** `orgs/get` (site-admin list) sort keys. */
export type OrgSortKey = 'slug' | 'display_name' | 'member_count' | 'scope_count' | 'created_at';

/** `orgs/get` sort key → ORDER BY (counts order by their select aliases). */
const ORG_SORT_COLUMNS: SortColumns<OrgSortKey> = {
    slug: (d) => [['slug', d]],
    display_name: (d) => [[fn('LOWER', col('display_name')), d]],
    member_count: (d) => [[literal('"member_count"'), d]],
    scope_count: (d) => [[literal('"scope_count"'), d]],
    created_at: (d) => [['created_at', d]],
};

export class OrgsService {
    constructor(
        private _org_repo: OrgRepository,
        private _org_member_repo: OrgMemberRepository,
        private _scope_repo: ScopeRepository,
        private _scope_member_repo: ScopeMemberRepository,
        private _user_repo: UserRepository,
        private _team_repo: TeamRepository,
        private _audit_repo?: AuditRepository,
        /** Sends the owner invite of a new org. */
        private _invitations?: InvitationsService,
        /** Restores a deleted org or owner on `reactivate: true`. */
        private _reactivation?: ReactivationService,
    ) {}

    /** This service's repositories, for the shared namespace check (lib/namespace.ts). */
    private _ns(): NamespaceRepos {
        return { org_repo: this._org_repo, scope_repo: this._scope_repo, user_repo: this._user_repo };
    }

    private _require_auth(auth: AuthContext) {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
    }

    // ─── Unified list (replaces list_my_orgs + admin_list_orgs) ─────

    /**
     * `orgs/get`: the caller's live orgs, or (site admin without `mine`) every
     * org; each row carries its status, owner and `deleted_at`. Deleted orgs are listed
     * only for a site admin with `include_deleted` (or `status: 'deleted'`).
     *
     * @throws ApiError 400 when `sort_by` is sent with the member list
     */
    async get(auth: AuthContext, params: {
        search?: string; limit?: number; offset?: number; mine?: boolean;
        sort_by?: OrgSortKey; sort_dir?: SortDir; status?: OrgStatus; include_deleted?: boolean;
    }) {
        log.debug('get', { user_id: auth.user?.id });
        this._require_auth(auth);

        if (auth.user!.role === 'admin' && !params.mine) {
            return this._get_admin(auth, params);
        }
        // The member list is every org of the caller (unpaged, by slug); sorting applies to the admin list.
        if (params.sort_by) {
            throw new ApiError('invalid_params', 'sort_by applies to the site-admin org list only (not with mine)', 400);
        }

        const rows = await this._org_member_repo.list_my_orgs(auth.user!.id);
        const owners = await this._owners_by_id(rows.map((r) => r.owner_id));
        const orgs = rows.map(({ owner_id, ...row }) => {
            const owner = owner_id ? owners.get(owner_id) : undefined;
            return { ...row, owner: owner ? { username: owner.username, status: owner.status } : null };
        });
        return { orgs };
    }

    private async _get_admin(_auth: AuthContext, params: {
        search?: string; limit?: number; offset?: number;
        sort_by?: OrgSortKey; sort_dir?: SortDir; status?: OrgStatus; include_deleted?: boolean;
    }) {
        const limit = Math.min(params.limit || 50, 100);
        const offset = params.offset || 0;

        const where: Record<string, unknown> = {};
        if (params.search) {
            where[Op.or as unknown as string] = [
                { slug: { [Op.iLike]: `%${escape_like(params.search)}%` } },
                { display_name: { [Op.iLike]: `%${escape_like(params.search)}%` } },
            ];
        }
        if (params.status === 'deleted') {
            where.deleted_at = { [Op.ne]: null };
        } else {
            if (params.status) where.status = params.status;
            if (!params.include_deleted) where.deleted_at = null;
        }

        const total = await _org_repo_os.find_count_q({ where });

        // Default: an exact slug match first when searching, then newest first.
        // The search value is a Sequelize value (escaped), never spliced into SQL text.
        const order_clause = list_order(ORG_SORT_COLUMNS, params, params.search
            ? [equals_first('slug', params.search.toLowerCase()), ['created_at', 'DESC']]
            : [['created_at', 'DESC']]);

        const rows = await _org_repo_os.find_all_q({
            where,
            attributes: [
                'id', 'slug', 'display_name',
                [literal('(SELECT count(*) FROM org_members om WHERE om.org_id = "Org"."id" AND om.status = \'active\' AND om.deleted_at IS NULL)'), 'member_count'],
                [literal('(SELECT count(*) FROM scopes s WHERE s.org_id = "Org"."id")'), 'scope_count'],
                // Members holding the org's `owner` role (0 = ownerless org; Admin flags it).
                // Rows not yet backfilled (role_id NULL) count when legacy role is owner/admin —
                // migrate_org_roles promotes the first admin to owner at next boot.
                [literal('(SELECT count(*) FROM org_members om LEFT JOIN org_roles r ON r.id = om.role_id WHERE om.org_id = "Org"."id" AND om.status = \'active\' AND om.deleted_at IS NULL AND (r.slug = \'owner\' OR (om.role_id IS NULL AND om.role IN (\'owner\', \'admin\'))))'), 'owner_count'],
                'created_at', 'status', 'owner_id', 'deleted_at',
            ],
            order: order_clause,
            limit,
            offset,
            raw: true,
        }) as unknown as Array<Record<string, unknown> & { owner_id: string | null; status: OrgStatus; deleted_at: Date | null }>;

        const owners = await this._owners_by_id(rows.map((r) => r.owner_id));
        const orgs = rows.map(({ owner_id, deleted_at, status, ...rest }) => {
            const owner = owner_id ? owners.get(String(owner_id)) : undefined;
            return {
                ...rest,
                status: deleted_at ? 'deleted' as const : status,
                owner: owner ? { username: owner.username, status: owner.status } : null,
                deleted_at: deleted_at ? new Date(deleted_at).toISOString() : null,
            };
        });

        return { orgs, total, limit, offset };
    }

    /** Whether the user holds `org.members.manage` in the org. */
    private async _can_manage_members(org_id: string, user_id: string): Promise<boolean> {
        const { require_permission } = await import('../auth/permissions.js');
        try {
            await require_permission(org_id, user_id, 'org.members.manage');
            return true;
        } catch {
            return false;
        }
    }

    /** Owner users (deleted ones included) by id, with their list status. */
    private async _owners_by_id(ids: Array<string | null>) {
        const wanted = [...new Set(ids.filter((x): x is string => Boolean(x)).map(String))];
        const out = new Map<string, { user_id: string; username: string | null; status: UserListStatus }>();
        if (!wanted.length) return out;
        const users = await _user_repo_os.find_all_q({
            where: { id: { [Op.in]: wanted } }, attributes: ['id', 'username', 'status', 'deleted_at'], raw: true,
        });
        for (const u of users) out.set(String(u.id), { user_id: String(u.id), username: u.username ?? null, status: user_list_status(u) });
        return out;
    }

    // ─── Get org by ID ──────────────────────────────────────────────

    /**
     * `orgs/get_by_id`: the org with its status, owner, `deleted_at`, the
     * pending owner invite (while waiting for the owner), members, scopes,
     * roles and the permission catalog. `my_role` is `site_admin` for a site
     * admin, else the slug of the caller's org role (`owner`, `admin`, …). Site admins and members with
     * `org.members.manage` see pending and former members (status `pending`
     * / `deleted`) and member emails; other members see active members
     * without emails. A site admin can open a deleted org; members only see
     * live ones.
     *
     * @throws ApiError 403 not a member; 404 unknown (or deleted, for a non-admin)
     */
    async get_by_id(auth: AuthContext, params: { org_id: string }) {
        log.debug('get_by_id', { org_id: params.org_id, user_id: auth.user?.id });
        this._require_auth(auth);

        let my_role: string = 'member';
        let my_role_id: string | null = null;
        if (auth.user!.role === 'admin') {
            my_role = 'site_admin';
        }
        if (my_role !== 'site_admin') {
            const membership = await this._org_member_repo.find_by_org_and_user(params.org_id, auth.user!.id);
            if (!membership) throw new ApiError('forbidden', 'You are not a member of this org', 403);
            my_role = membership.role;
            my_role_id = membership.role_id ? String(membership.role_id) : null;
        }

        const org = my_role === 'site_admin'
            ? await this._org_repo.find_by_id_with_deleted(params.org_id)
            : await this._org_repo.find_by_id(params.org_id);
        if (!org) throw new ApiError('not_found', 'Org not found', 404);

        // Pending and former members, and member emails, are for those who manage members.
        const all_members = await this._org_member_repo.list_members_by_org(params.org_id);
        const members = my_role === 'site_admin' || await this._can_manage_members(params.org_id, auth.user!.id)
            ? all_members
            : all_members.filter((m) => m.status === 'active').map(({ email: _email, ...m }) => m);
        const { OrgRoleService } = await import('./org_role_service.js');
        const roles = await OrgRoleService.list(params.org_id);
        // The caller's role is the slug of the org role they hold (owner, admin,
        // member or a custom role); the legacy `role` text (owners hold 'admin')
        // only answers for a membership without one.
        if (my_role_id) my_role = roles.find((r) => String(r.id) === my_role_id)?.slug ?? my_role;
        const { ALL_PERMISSIONS, OWNER_ONLY_PERMISSIONS } = await import('../auth/permissions.js');

        const scopes = await _scope_repo_os.find_all_q({
            where: { org_id: params.org_id },
            attributes: [
                'id', 'slug', 'display_name', 'visibility',
                [literal('(SELECT count(*) FROM scope_members sm WHERE sm.scope_id = "Scope"."id")'), 'member_count'],
                [literal('(SELECT count(*) FROM teams t WHERE t.scope = "Scope"."slug")'), 'team_count'],
            ],
            order: [['slug', 'ASC']],
            raw: true,
        });

        const owner = (await this._owners_by_id([org.owner_id])).get(String(org.owner_id)) ?? null;
        const owner_invite = await AccountInvite.findOne({
            where: { org_id: org.id, role: 'owner', status: 'pending', expires_at: { [Op.gt]: new Date() } },
            attributes: ['id', 'email', 'expires_at'],
            order: [['created_at', 'DESC']],
            raw: true,
        });

        return {
            id: org.id,
            slug: org.slug,
            display_name: org.display_name,
            created_at: org.created_at,
            status: org.deleted_at ? 'deleted' as const : org.status,
            owner,
            deleted_at: org.deleted_at ? new Date(org.deleted_at).toISOString() : null,
            pending_owner_invite: owner_invite
                ? { invite_id: owner_invite.id, email: owner_invite.email, expires_at: new Date(owner_invite.expires_at).toISOString() }
                : null,
            my_role,
            members,
            scopes,
            roles,
            available_permissions: [...ALL_PERMISSIONS],
            owner_only_permissions: [...OWNER_ONLY_PERMISSIONS],
        };
    }

    /**
     * Org-scoped picker targets for HUG reviewers / dispatch destinations:
     * notification channels (and users when wired). Caller must be an org member.
     * `org_id` is required — no header-based fallback.
     */
    async get_reviewable_targets(
        auth: AuthContext,
        params: { org_id: string; query?: string },
    ): Promise<{ users: Array<{ username: string; display_name?: string }>; channels: Array<{ id: string; name: string }> }> {
        log.debug('get_reviewable_targets', { org_id: params.org_id, user_id: auth.user?.id });
        this._require_auth(auth);

        const org_id = params.org_id;
        if (!org_id) throw new ApiError('invalid_params', 'org_id is required', 400);

        // Route policy: member of org_id.
        const query = (params.query ?? '').trim().toLowerCase();
        const { NotificationChannel } = await import('../models/index.js');
        const channel_where: Record<string, unknown> = {
            org_id,
            enabled: 1,
        };
        if (query) {
            channel_where.name = { [Op.iLike]: `%${query}%` };
        }
        const channel_rows = await NotificationChannel.findAll({
            where: channel_where,
            attributes: ['id', 'name'],
            order: [['name', 'ASC']],
            limit: 100,
        });

        return {
            users: [],
            channels: channel_rows.map((c) => ({ id: c.id, name: c.name })),
        };
    }

    // ─── Create org (site admin) ────────────────────────────────────

    /**
     * Creates an org for its future owner, in one transaction: the owner is an
     * existing user (`owner.user_id`) or someone invited by email (an
     * `invited` user is created when nobody has the address). The org starts
     * `waiting_for_owner` with the owner's pending membership, its default
     * roles, scope, notification channels and rules, and the owner invite
     * (`invite.owner.sent`). The org becomes active, and gets its default
     * realm, when the owner accepts.
     *
     * With `reactivate: true` a site admin restores the deleted org holding
     * the slug (same id) and sends it a new owner invite; a deleted owner
     * account is restored the same way.
     *
     * The owner is checked first: an unknown `user_id` is 404, a suspended
     * owner `409 not_active`; an invited person (no account yet) is invited
     * like an email address.
     *
     * @throws ApiError 422 invalid_params; 404 not_found (owner.user_id);
     *   409 not_active (suspended owner); 409 conflict (slug taken, also by a
     *   concurrent create); 409 deleted (slug or owner belongs to a deleted
     *   row); 403 forbidden (reactivate by a non site admin); whatever
     *   ReactivationService throws when restoring.
     */
    async new_org(auth: AuthContext, params: {
        slug: string;
        display_name?: string;
        owner: { user_id: string } | { email: string; display_name?: string };
        reactivate?: boolean;
    }) {
        log.debug('new_org', { slug: params.slug, user_id: auth.user?.id });
        // Route policy: site admin (/v1/orgs/new and /internal/orgs/new).
        this._require_auth(auth);
        const invitations = this._invitations;
        const reactivation = this._reactivation;
        if (!invitations || !reactivation) throw new ApiError('internal_error', 'Org creation is not wired', 500);

        const slug = params.slug.toLowerCase();
        if (!SLUG_PATTERN.test(slug)) throw new ApiError('invalid_params', 'Slug must start with a letter and contain only lowercase letters, numbers, and hyphens', 422);
        if (RESERVED_SCOPES.includes(slug)) throw new ApiError('invalid_params', `Slug '${slug}' is reserved`, 422);

        const owner_input = params.owner;
        let owner_email: string;
        let owner_row: { id: string; status: string; deleted_at: Date | null } | null = null;
        if ('user_id' in owner_input) {
            const user = await UserModel.findByPk(owner_input.user_id, { attributes: ['id', 'email', 'status', 'deleted_at'], raw: true });
            if (!user) throw new ApiError('not_found', 'Owner user not found', 404);
            if (user.deleted_at && !params.reactivate) throw deleted_user_error({ ...user, deleted_at: user.deleted_at }, `The user ${user.email} was deleted`);
            // A suspended account cannot take ownership; an invited person (no account yet) gets the invite like any email.
            if (!user.deleted_at && user.status === 'suspended') throw ApiError.not_active('suspended', 'Unsuspend the owner first.');
            owner_email = user.email;
            owner_row = { id: String(user.id), status: user.status, deleted_at: user.deleted_at };
        } else {
            owner_email = normalize_email(owner_input.email, 'owner.email');
        }

        // A deleted org holding the slug comes back with reactivate (site admin).
        let restore_org_id: string | null = null;
        try {
            await assert_namespace_free(this._ns(), slug, ['org', 'scope', 'user']);
        } catch (err) {
            const details = err instanceof ApiError ? err.details as { kind?: string; id?: string } | undefined : undefined;
            if (!params.reactivate || !(err instanceof ApiError) || err.code !== 'deleted' || details?.kind !== 'org') throw err;
            reactivation.assert_can_reactivate(auth);
            restore_org_id = String(details.id);
        }

        const display_name = params.display_name?.trim() || slug;
        const now = new Date();
        const created = await on_name_race(() => get_sequelize().transaction(async (transaction) => {
            let owner_id: string;
            if (owner_row) {
                owner_id = owner_row.id;
                if (owner_row.deleted_at) {
                    reactivation.assert_can_reactivate(auth);
                    await reactivation.restore_user(auth, owner_id, transaction);
                }
            } else {
                owner_id = await invitations.invitee_user_id(auth, owner_email, {
                    reactivate: params.reactivate,
                    display_name: 'display_name' in owner_input ? owner_input.display_name : undefined,
                    t: transaction,
                });
            }

            let org_id: string;
            if (restore_org_id) {
                org_id = (await reactivation.restore_org(auth, restore_org_id, transaction)).id;
                await OrgModel.update({ status: 'waiting_for_owner', owner_id }, { where: { id: org_id }, transaction });
            } else {
                const org = await _org_repo_os.create_one({ slug, display_name, status: 'waiting_for_owner', owner_id, activated_at: null }, { transaction });
                org_id = org.id;
                await seed_default_roles_for_org(org_id, transaction);
                await OrgSeedService.seed_org(org_id, { account: false, transaction });
                // Default org scope (registry namespace = org slug); the owner joins it on accept.
                const scope = await _scope_repo_os.create_one({
                    slug, display_name, owner_id, visibility: 'public', scope_type: 'org', org_id,
                }, { transaction });
                await OrgModel.update({ default_scope_id: scope.id } as never, { where: { id: org_id }, transaction });
            }

            const sent = await invitations.send_in_transaction(transaction, {
                target: 'org', org_id, realm_id: null, email: owner_email, role: 'owner',
                user_id: owner_id, actor_id: String(auth.user!.id), now,
            });
            if (this._audit_repo) {
                await this._audit_repo.create(auth.user!.id, restore_org_id ? 'org.reactivate' : 'org.create', 'org', slug, {
                    org_id, owner_user_id: owner_id, owner_invite_id: sent.invite.id,
                }, transaction);
            }
            const org = (await OrgModel.findByPk(org_id, { attributes: ['id', 'slug', 'display_name', 'status', 'created_at'], raw: true, transaction }))!;
            const owner = (await UserModel.findByPk(owner_id, { attributes: ['id', 'email', 'status'], raw: true, transaction }))!;
            return { org, owner, sent };
        }), () => assert_namespace_free(this._ns(), slug, ['org', 'scope', 'user']));

        const delivery = await invitations.delivery_outcome(created.sent);
        const { org, owner, sent } = created;
        log.info('org_created', { org_id: org.id, slug, reactivated: Boolean(restore_org_id), owner_invite_id: sent.invite.id, email_sent: delivery.email_sent });
        return {
            org: {
                id: String(org.id),
                slug: org.slug,
                display_name: org.display_name,
                status: org.status,
                owner: { user_id: String(owner.id), email: owner.email, status: owner.status },
                created_at: new Date(org.created_at).toISOString(),
                reactivated: Boolean(restore_org_id),
            },
            owner_invite: {
                invite_id: sent.invite.id,
                role: 'owner' as const,
                status: 'pending' as const,
                expires_at: sent.invite.expires_at.toISOString(),
                ...delivery,
            },
        };
    }

    // ─── Update org ─────────────────────────────────────────────────

    async update(auth: AuthContext, params: { org_id: string; display_name: string }) {
        log.debug('update', { org_id: params.org_id, user_id: auth.user?.id });
        // Route policy: org.settings in org_id.
        await this._org_repo.update_display_name(params.org_id, params.display_name);
        log.info('org_updated', { org_id: params.org_id });
        return { updated: true };
    }

    // ─── Delete org ───────
    // Route policy: /v1/orgs/delete → org.delete (owner); /internal/orgs/delete → site admin.

    /**
     * Soft-deletes an org in one transaction ({@link soft_delete_org}): the org
     * keeps its row, id and slug (the slug stays taken), its members become
     * former members, pending invites are revoked and its realms are
     * soft-deleted; their tokens are revoked after commit. Scopes, channels,
     * rules and settings stay for a reactivation.
     *
     * @returns `{ id, deleted_at }` (ISO time).
     * @throws ApiError 404 unknown or already deleted org; 409 for a personal
     *   org (non-admin), when the org's scopes still hold teams, or a realm has
     *   a run in progress, an active dispatch job or a daemon (remove those first).
     */
    async delete_org(auth: AuthContext, params: { org_id: string }) {
        log.debug('delete_org', { org_id: params.org_id, user_id: auth.user?.id });
        this._require_auth(auth);

        const org = await _org_repo_os.find_by_id(params.org_id);
        if (!org) throw new ApiError('not_found', 'Org not found', 404);

        // A personal org (slug = its user's username) is removed with the user, not on its own.
        if (auth.user!.role !== 'admin' && await this._user_repo.find_by_username(org.slug)) {
            throw new ApiError('conflict', 'A personal org cannot be deleted', 409);
        }

        const org_scopes = await _scope_repo_os.find_all_q({ where: { org_id: org.id }, attributes: ['slug'], raw: true });
        const scope_slugs = org_scopes.map(s => s.slug);
        if (scope_slugs.length > 0) {
            const team_count = await _team_repo_os.find_count_q({ where: { scope: { [Op.in]: scope_slugs } } });
            if (team_count > 0) {
                throw new ApiError('conflict', `Cannot delete org with ${team_count} team(s) — delete or transfer teams first`, 409);
            }
        }
        const blocker = await RealmService.org_delete_blocker(org.id);
        if (blocker) throw new ApiError('conflict', `Cannot delete org ${org.slug}: ${blocker}`, 409);

        const deleted_at = new Date();
        const realms = await get_sequelize().transaction(async (t) => {
            const removed = await soft_delete_org({ id: org.id }, t, deleted_at);
            if (this._audit_repo) {
                await this._audit_repo.create(auth.user!.id, 'org.delete', 'org', org.slug, { org_id: org.id, scopes: scope_slugs, realms: removed.map((r) => r.slug) }, t);
            }
            return removed;
        });
        await RealmService.after_org_realms_removed(realms, String(auth.user!.id));

        log.info('org_deleted', { org_id: params.org_id, slug: org.slug, realms: realms.length });
        return { id: org.id, deleted_at: deleted_at.toISOString() };
    }

    // ─── Member management ──────────────────────────────────────────

    async remove_member(auth: AuthContext, params: { org_id: string; user_id: string }) {
        log.debug('remove_member', { org_id: params.org_id, user_id: params.user_id });
        // Route policy: org.members.manage in org_id.
        const member = await this._org_member_repo.find_by_org_and_user(params.org_id, params.user_id);
        if (!member) throw new ApiError('not_found', 'Member not found', 404);

        if (member.role === 'admin') {
            const admin_count = await this._org_member_repo.count_admins_by_org(params.org_id);
            if (admin_count <= 1) throw new ApiError('conflict', 'Cannot remove the last org admin', 409);
        }

        await this._scope_member_repo.delete_by_user_and_org_scopes(params.user_id, params.org_id);
        await this._org_member_repo.delete_by_org_and_user(params.org_id, params.user_id);

        // Revoke membership from all org realms
        await OrgRealmSyncService.sync_member_removed(params.org_id, params.user_id);

        /** Delete personal notification channel — CASCADE removes its destinations. */
        try {
            const { NotificationChannel } = await import('../models/index.js');
            await NotificationChannel.destroy({
                where: { user_id: params.user_id, org_id: params.org_id },
            });
        } catch (err) {
            log.debug('per_user_channel_remove_failed', { error: err instanceof Error ? err.message : String(err) });
            /* Best-effort — channel may not exist. */
        }

        return { removed: true };
    }

    async leave(auth: AuthContext, params: { org_id: string }) {
        log.debug('leave', { org_id: params.org_id, user_id: auth.user?.id });
        this._require_auth(auth);
        const membership = await this._org_member_repo.find_by_org_and_user(params.org_id, auth.user!.id);
        if (!membership) throw new ApiError('not_found', 'You are not a member of this org', 404);

        if (membership.role === 'admin') {
            const admin_count = await this._org_member_repo.count_admins_by_org(params.org_id);
            if (admin_count <= 1) throw new ApiError('conflict', 'Cannot leave as the last org admin — promote someone else first', 409);
        }

        await this._scope_member_repo.delete_by_user_and_org_scopes(auth.user!.id, params.org_id);
        await this._org_member_repo.delete_by_org_and_user(params.org_id, auth.user!.id);

        // Revoke realm memberships
        await OrgRealmSyncService.sync_member_removed(params.org_id, auth.user!.id);

        return { left: true };
    }

    // ─── Scope management ───────────────────────────────────────────

    async new_scope(auth: AuthContext, params: { org_id: string; slug: string; display_name?: string; visibility?: 'public' | 'private' }) {
        log.debug('new_scope', { org_id: params.org_id, slug: params.slug });
        // Route policy: org.scopes.manage in org_id.
        const org = await this._org_repo.find_by_id(params.org_id);
        if (!org) throw new ApiError('not_found', 'Org not found', 404);

        const slug = params.slug.toLowerCase();
        if (!SLUG_PATTERN.test(slug)) throw new ApiError('invalid_params', 'Slug must start with a letter and contain only lowercase letters, numbers, and hyphens', 422);
        if (slug !== org.slug && !slug.startsWith(org.slug + '-')) {
            throw new ApiError('invalid_params', `Scope slug must be '${org.slug}' or start with '${org.slug}-'`, 422);
        }
        if (RESERVED_SCOPES.includes(slug)) throw new ApiError('invalid_params', `Scope '${slug}' is reserved`, 422);

        // Shared namespace (lib/namespace.ts): the org's own slug is fine for its scope; any other holder conflicts.
        for (const h of await namespace_holders(this._ns(), slug, ['scope', 'org', 'user'])) {
            if (h.kind === 'org' && slug === org.slug) continue;
            if (h.kind === 'user' && slug === org.slug) continue; // the user of this personal org
            throw namespace_conflict(h);
        }

        const display_name = params.display_name || slug;
        const visibility = params.visibility || 'public';
        const scope_id = await this._scope_repo.create(slug, display_name, auth.user!.id, visibility, 'org', undefined, params.org_id);

        const admins = await this._org_member_repo.list_admins_by_org(params.org_id);
        for (const a of admins) {
            await this._scope_member_repo.create_on_conflict_ignore(scope_id, a.user_id);
        }

        return { id: scope_id, slug };
    }

    async delete_scope(auth: AuthContext, params: { org_id: string; scope_id: string }) {
        log.debug('delete_scope', { org_id: params.org_id, scope_id: params.scope_id });
        // Route policy: org.scopes.manage in org_id.
        const scope = await _scope_repo_os.find_one_q({
            where: { id: params.scope_id, org_id: params.org_id },
            attributes: ['id', 'slug', 'org_id'],
            raw: true,
        });
        if (!scope) throw new ApiError('not_found', 'Scope not found in this org', 404);

        const org = await this._org_repo.find_by_id(params.org_id);
        if (org && scope.slug === org.slug) {
            throw new ApiError('conflict', 'Cannot delete the default org scope', 409);
        }

        const team_rows = await this._team_repo.list_by_scope(scope.slug);
        if (team_rows.length > 0) {
            throw new ApiError('conflict', `Cannot delete scope with ${team_rows.length} team(s)`, 409);
        }

        await this._scope_member_repo.delete_by_scope_id(params.scope_id);
        await this._scope_repo.delete_by_id(params.scope_id);
        return { deleted: true };
    }

    async assign_scope_member(auth: AuthContext, params: { org_id: string; scope_id: string; user_id: string }) {
        log.debug('assign_scope_member', { org_id: params.org_id, scope_id: params.scope_id, user_id: params.user_id });
        // Route policy: org.scopes.manage in org_id.
        const scope = await _scope_repo_os.find_one_q({
            where: { id: params.scope_id, org_id: params.org_id },
            attributes: ['id'],
            raw: true,
        });
        if (!scope) throw new ApiError('not_found', 'Scope not found in this org', 404);

        const member = await this._org_member_repo.find_by_org_and_user(params.org_id, params.user_id);
        if (!member) throw new ApiError('conflict', 'User is not a member of this org', 409);

        const existing = await this._scope_member_repo.find_by_scope_and_user(params.scope_id, params.user_id);
        if (existing) throw new ApiError('conflict', 'User is already assigned to this scope', 409);

        await this._scope_member_repo.create(params.scope_id, params.user_id);
        return { assigned: true };
    }

    async unassign_scope_member(auth: AuthContext, params: { org_id: string; scope_id: string; user_id: string }) {
        log.debug('unassign_scope_member', { org_id: params.org_id, scope_id: params.scope_id, user_id: params.user_id });
        // Route policy: org.scopes.manage in org_id.
        const scope = await _scope_repo_os.find_one_q({
            where: { id: params.scope_id, org_id: params.org_id },
            attributes: ['id'],
            raw: true,
        });
        if (!scope) throw new ApiError('not_found', 'Scope not found in this org', 404);

        const count = await this._scope_member_repo.delete_by_scope_and_user(params.scope_id, params.user_id);
        return { removed: count > 0 };
    }
}
