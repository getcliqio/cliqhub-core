import { Scope, ScopeMember, User } from '../models/index.js';
import { Op, literal, type Transaction, type WhereOptions } from 'sequelize';
import { BaseRepository } from './base_repository.js';

const SCOPE_ATTRS = ['id', 'slug', 'display_name', 'visibility', 'scope_type', 'owner_id', 'org_id'] as const;

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
                'id', 'slug', 'display_name', 'owner_id', 'org_id', 'visibility', 'scope_type', 'created_at',
                [literal('(SELECT count(*) FROM teams t WHERE t.scope = "Scope"."slug")'), 'team_count'],
            ],
            include: [{ model: User, attributes: ['username'], required: false }],
            order: opts.order ?? [['created_at', 'DESC']],
            limit: opts.limit,
            offset: opts.offset,
            raw: true,
            nest: true,
        });
    }
    async find_owned_by_user(user_id: string) {
        return Scope.findAll({
            where: { owner_id: user_id, scope_type: 'user' },
            attributes: [...SCOPE_ATTRS],
            raw: true,
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
            where: { id: { [Op.in]: scope_ids }, scope_type: 'org' },
            attributes: [...SCOPE_ATTRS],
            raw: true,
        });
    }

    /** Return all system-default scopes (every authenticated user can access these). */
    async find_default_scopes() {
        return Scope.findAll({
            where: { is_default: 1 },
            attributes: [...SCOPE_ATTRS],
            raw: true,
        });
    }

    async find_by_slug(slug: string) {
        return Scope.findOne({ where: { slug }, attributes: ['id'], raw: true });
    }

    async find_by_slug_with_transaction(slug: string, transaction: Transaction) {
        return Scope.findOne({ where: { slug }, attributes: ['id'], raw: true, transaction });
    }

    async delete_by_id(id: string): Promise<number> {
        return Scope.destroy({ where: { id } });
    }

    async create(
        slug: string, display_name: string, owner_id: string,
        visibility: string, scope_type: string, transaction?: Transaction,
        org_id?: string,
    ): Promise<string> {
        const scope = await Scope.create(
            { slug, display_name, owner_id, visibility, scope_type, ...(org_id != null ? { org_id } : {}) },
            { transaction },
        );
        return scope.id;
    }
}
