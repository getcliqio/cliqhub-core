import { Scope, ScopeMember, User } from '../models/index.js';
import { Op, literal, type Transaction, type WhereOptions } from 'sequelize';
import { BaseRepository } from './base_repository.js';

const SCOPE_ATTRS = ['id', 'slug', 'display_name', 'owner_id', 'org_id'] as const;

export class ScopeRepository extends BaseRepository<Scope> {
    protected readonly model = Scope;

    /** Admin catalog page with team count and owner username. */
    async find_catalog_page(
        where: WhereOptions<any>,
        opts: { order?: any; limit?: number; offset?: number },
    ): Promise<any[]> {
        return Scope.findAll({
            where,
            attributes: [
                'id', 'slug', 'display_name', 'owner_id', 'org_id', 'created_at',
                [literal('(SELECT count(*) FROM teams t WHERE t.scope = "Scope"."slug")'), 'team_count'],
                [literal('(SELECT o.slug FROM orgs o WHERE o.id = "Scope"."org_id")'), 'org_slug'],
            ],
            include: [{ model: User, attributes: ['username'], required: false }],
            order: opts.order ?? [['created_at', 'DESC']],
            limit: opts.limit,
            offset: opts.offset,
            raw: true,
            nest: true,
        });
    }
    async find_by_org_ids(org_ids: string[]) {
        if (org_ids.length === 0) return [];
        return Scope.findAll({
            where: { org_id: { [Op.in]: org_ids } },
            attributes: [...SCOPE_ATTRS],
            raw: true,
        });
    }

    async find_member_scopes(user_id: string) {
        const members = await ScopeMember.findAll({
            where: { user_id },
            attributes: ['scope_id'],
            raw: true,
        });
        if (members.length === 0) return [];
        const scope_ids = members.map(m => m.scope_id);
        return Scope.findAll({
            where: { id: { [Op.in]: scope_ids } },
            attributes: [...SCOPE_ATTRS],
            raw: true,
        });
    }

    /** The default scopes (`@cliq`): their public teams are on every org's Teams list (PLAN-team-visibility §3.6). */
    async find_default_scopes() {
        return Scope.findAll({
            where: { is_default: 1 },
            attributes: [...SCOPE_ATTRS],
            raw: true,
        });
    }

    /** The scope holding `slug` (with its org and owner, for publishing and namespace conflict messages). */
    async find_by_slug(slug: string) {
        return Scope.findOne({ where: { slug }, attributes: ['id', 'slug', 'org_id', 'owner_id'], raw: true });
    }

    async find_by_slug_with_transaction(slug: string, transaction: Transaction) {
        return Scope.findOne({ where: { slug }, attributes: ['id'], raw: true, transaction });
    }

    async delete_by_id(id: string): Promise<number> {
        return Scope.destroy({ where: { id } });
    }

    /** Create a scope of `org_id` (every scope belongs to an org, PLAN-team-visibility §3.1). */
    async create(
        slug: string, display_name: string, owner_id: string, org_id: string, transaction?: Transaction,
    ): Promise<string> {
        const scope = await Scope.create({ slug, display_name, owner_id, org_id }, { transaction });
        return scope.id;
    }
}
