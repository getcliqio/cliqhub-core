import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';

import { Scope } from '../models/index.js';
import { ApiError } from '../lib/api_error.js';


export class ScopeService {

    static async list() {
        return Scope.findAll({ order: [['is_default', 'DESC'], ['slug', 'ASC']] });
    }

    static async get_default() {
        return Scope.findOne({ where: { is_default: 1 } });
    }

    static async set_default(slug: string): Promise<boolean> {
        const target = await Scope.findOne({ where: { slug } });
        if (!target) return false;

        await Scope.update({ is_default: 0 }, { where: { is_default: 1 } });
        await Scope.update({ is_default: 1 }, { where: { slug } });
        return true;
    }

    static async add(slug: string, name?: string | null, org_id?: string | null, scope_type?: string | null) {
        const existing = await Scope.findOne({ where: { slug } });
        if (existing) return existing;

        const count = await Scope.count();
        const is_default = count === 0 ? 1 : 0;

        return Scope.create({
            id: randomUUID(),
            slug,
            name: name ?? null,
            org_id: org_id ?? null,
            scope_type: scope_type ?? null,
            is_default,
            created_at: Date.now(),
        });
    }

    static async remove(slug: string): Promise<boolean> {
        const deleted = await Scope.destroy({ where: { slug } });
        return deleted > 0;
    }

    static async find_by_id(id: string) {
        return Scope.findByPk(id);
    }

    static async find_by_slug(slug: string) {
        return Scope.findOne({ where: { slug } });
    }

    /**
     * Docker-style resolution: accepts @slug, slug, or UUID.
     * Returns the scope or throws 404.
     */
    static async resolve(ref: string): Promise<Scope> {
        const slug = ref.startsWith('@') ? ref.slice(1) : ref;
        const scope = await Scope.findOne({
            where: { [Op.or]: [{ id: ref }, { slug }] },
        });
        if (!scope) throw ApiError.not_found(`Scope '${ref}' not found`);
        return scope;
    }

    static async list_by_org_ids(org_ids: string[]): Promise<Scope[]> {
        if (org_ids.length === 0) return [];
        return Scope.findAll({
            where: { org_id: { [Op.in]: org_ids } },
            order: [['slug', 'ASC']],
        });
    }
}
