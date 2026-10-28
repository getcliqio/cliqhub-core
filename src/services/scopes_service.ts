import { ApiError } from '../errors/api_error.js';
import { get_logger } from '../lib/log.js';
import type { ScopeRepository } from '../repositories/scope_repository.js';
import type { ScopeMemberRepository } from '../repositories/scope_member_repository.js';
import type { TeamRepository } from '../repositories/team_repository.js';
import type { AuditRepository } from '../repositories/audit_repository.js';
import type { OrgRepository } from '../repositories/org_repository.js';
import type { OrgMemberRepository } from '../repositories/org_member_repository.js';
import type { AuthContext } from '../schemas/auth_types.js';
import { UserRepository } from '../repositories/user_repository.js';
import { Op, literal } from 'sequelize';
import { list_order, type SortColumns, type SortDir } from '../lib/list_sort.js';
import { assert_admin_access } from '../auth/assert_grant.js';
import { escape_like } from '../lib/search.js';

const log = get_logger('svc.scopes');

/** `orgs/get_scopes` sort keys. */
export type ScopeSortKey = 'slug' | 'team_count' | 'created_at';

/** `orgs/get_scopes` sort key → ORDER BY (team_count is the same subquery the catalog selects). */
const SCOPE_SORT_COLUMNS: SortColumns<ScopeSortKey> = {
    slug: (d) => [['slug', d]],
    team_count: (d) => [[literal('(SELECT count(*) FROM teams t WHERE t.scope = "Scope"."slug")'), d]],
    created_at: (d) => [['created_at', d]],
};

const user_repo = new UserRepository();

export class ScopesService {
    constructor(
        private _scope_repo: ScopeRepository,
        private _team_repo: TeamRepository,
        private _audit_repo: AuditRepository,
        private _org_repo: OrgRepository,
        private _org_member_repo: OrgMemberRepository,
        private _scope_member_repo: ScopeMemberRepository,
    ) {}

    private _require_auth(auth: AuthContext) {
        if (!auth.user) throw new ApiError('unauthorized', 'Authentication required', 401);
    }

    /** Site-admin grant on scopes entity. */
    private _require_scopes_admin(auth: AuthContext) {
        this._require_auth(auth);
        assert_admin_access(auth, 'scopes');
    }

    /**
     * "Your scopes" for a user (PLAN-team-visibility §3.1, §3.3): the scopes they are a member of
     * (assigned, or every scope of an org where they are owner or admin) and the scopes they can
     * publish to (every scope of an org where their role grants `teams.publish`).
     */
    async get_for_user(
        auth: AuthContext,
        user_id: string,
        params: { org_id?: string; search?: string; limit?: number; offset?: number; sort_by?: ScopeSortKey; sort_dir?: SortDir },
    ) {
        log.debug('get_for_user', { user_id, org_id: params.org_id });
        this._require_auth(auth);
        const limit = Math.min(params.limit ?? 50, 100);
        const offset = params.offset ?? 0;

        const { ScopeMember } = await import('../models/index.js');
        const member_rows = await ScopeMember.findAll({
            where: { user_id },
            attributes: ['scope_id'],
            raw: true,
        });
        const member_scope_ids = (member_rows as Array<{ scope_id: string }>).map((r) => r.scope_id);
        const org_ids = (await this._org_member_repo.find_orgs_by_user(user_id))
            .filter((m) => m.org_role && (m.org_role.is_system || m.org_role.slug === 'admin' || m.org_role.permissions.includes('teams.publish')))
            .map((m) => m.org_id);

        const yours: unknown[] = [];
        if (member_scope_ids.length > 0) yours.push({ id: { [Op.in]: member_scope_ids } });
        if (org_ids.length > 0) yours.push({ org_id: { [Op.in]: org_ids } });
        if (yours.length === 0) return { items: [], total: 0, offset, limit };

        const conditions: unknown[] = [{ [Op.or]: yours }];
        if (params.org_id) conditions.push({ org_id: params.org_id });
        if (params.search) {
            const like = `%${escape_like(params.search)}%`;
            conditions.push({ [Op.or]: [{ slug: { [Op.iLike]: like } }, { display_name: { [Op.iLike]: like } }] });
        }
        const where = { [Op.and]: conditions };

        const total = await this._scope_repo.find_count(where as any);
        const rows = await this._scope_repo.find_all(where as any, {
            attributes: ['id', 'slug', 'display_name', 'owner_id', 'org_id', 'created_at'],
            order: list_order(SCOPE_SORT_COLUMNS, params, [['slug', 'ASC']]),
            limit,
            offset,
            raw: true,
        });

        const items = rows.map((s: any) => ({
            id: s.id,
            slug: s.slug,
            display_name: s.display_name ?? null,
            owner_id: s.owner_id,
            org_id: s.org_id ?? null,
            created_at: s.created_at instanceof Date ? s.created_at.toISOString() : s.created_at,
        }));

        return { items, total, offset, limit };
    }

    /**
     * Full scope catalog for site admins — paginated, with optional org filter.
     * Replaces the get() path that required scopes_admin and lacked org_id filter.
     */
    async list_catalog(
        auth: AuthContext,
        params: { org_id?: string; search?: string; limit?: number; offset?: number; sort_by?: ScopeSortKey; sort_dir?: SortDir },
    ) {
        log.debug('list_catalog', { org_id: params.org_id });
        this._require_auth(auth);
        this._require_scopes_admin(auth);
        const limit = Math.min(params.limit ?? 50, 100);
        const offset = params.offset ?? 0;

        const where: Record<string, unknown> = {};
        if (params.org_id) {
            Object.assign(where, { org_id: params.org_id });
        }
        if (params.search) {
            const like = `%${escape_like(params.search)}%`;
            Object.assign(where, {
                [Op.or]: [
                    { slug: { [Op.iLike]: like } },
                    { display_name: { [Op.iLike]: like } },
                ],
            });
        }

        const total = await this._scope_repo.find_count(where as any);
        const rows = await this._scope_repo.find_catalog_page(where as any, {
            order: list_order(SCOPE_SORT_COLUMNS, params, [['created_at', 'DESC']]),
            limit,
            offset,
        });

        const scopes = rows.map((s: any) => ({
            id: s.id,
            slug: s.slug,
            display_name: s.display_name ?? null,
            owner_id: s.owner_id,
            org_id: s.org_id ?? null,
            org_slug: s.org_slug ?? null,
            team_count: Number(s.team_count ?? 0),
            owner_username: s.User?.username ?? null,
            created_at: s.created_at instanceof Date ? (s.created_at as Date).toISOString() : s.created_at,
        }));

        return { scopes, total, offset, limit };
    }

    async update(auth: AuthContext, params: {
        scope_id: string;
        display_name?: string;
        owner_id?: string;
    }) {
        log.debug('update', { scope_id: params.scope_id });
        this._require_scopes_admin(auth);

        const scope = await this._scope_repo.find_by_id(params.scope_id);
        if (!scope) throw new ApiError('not_found', 'Scope not found', 404);

        if (params.owner_id !== undefined) {
            const owner = await user_repo.find_by_id(params.owner_id);
            if (!owner) throw new ApiError('not_found', 'Owner user not found', 404);
        }

        const updates: Record<string, unknown> = {};
        const changes: Record<string, unknown> = {};

        if (params.display_name !== undefined && params.display_name !== scope.display_name) {
            updates.display_name = params.display_name;
            changes.display_name = { from: scope.display_name, to: params.display_name };
        }

        if (params.owner_id !== undefined && params.owner_id !== scope.owner_id) {
            updates.owner_id = params.owner_id;
            changes.owner_id = { from: scope.owner_id, to: params.owner_id };
        }

        if (Object.keys(updates).length === 0) return { updated: false };

        await this._scope_repo.update_where({ id: scope.id } as any, updates);
        await this._audit_repo.create(auth.user!.id, 'scope.update', 'scope', scope.slug, changes);
        log.info('scope_updated', { scope_id: params.scope_id });
        return { updated: true };
    }
}
