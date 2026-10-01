import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';

import type { Scope } from '../models/scope.model.js';
import { ScopeRepository } from '../repositories/scope_repository.js';

const _scope_repo_cs = new ScopeRepository();
import { ApiError } from '../lib/api_error.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('svc.control_scope');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const is_uuid = (s: string) => UUID_RE.test(s);


export class ScopeService {

    static async list() {
        log.debug('list', {});
        return _scope_repo_cs.find_all_q({ order: [['is_default', 'DESC'], ['slug', 'ASC']] });
    }

    static async get_default() {
        log.debug('get_default', {});
        return _scope_repo_cs.find_one_q({ where: { is_default: 1 } });
    }

    static async set_default(slug: string): Promise<boolean> {
        log.debug('set_default', { slug });
        const target = await _scope_repo_cs.find_one_q({ where: { slug } });
        if (!target) return false;

        await _scope_repo_cs.update_where({ is_default: 1 } as any, { is_default: 0 } as any);
        await _scope_repo_cs.update_where({ slug } as any, { is_default: 1 } as any);
        return true;
    }

    static async add(slug: string, display_name?: string | null, org_id?: string | null, scope_type?: string | null) {
        log.debug('add', { slug, org_id });
        const existing = await _scope_repo_cs.find_one_q({ where: { slug } });
        if (existing) return existing;

        const count = await _scope_repo_cs.find_count();
        const is_default = count === 0 ? 1 : 0;

        return _scope_repo_cs.create_one({
            id: randomUUID(),
            slug,
            display_name: display_name ?? '',
            owner_id: null,
            org_id: org_id ?? null,
            scope_type: scope_type ?? 'platform',
            visibility: 'public',
            is_default,
        });
    }

    static async remove(slug: string): Promise<boolean> {
        log.debug('remove', { slug });
        const deleted = await _scope_repo_cs.delete_where({ slug } as any);
        return deleted > 0;
    }

    static async find_by_id(id: string) {
        log.debug('find_by_id', { id });
        if (!is_uuid(id)) return null;
        return _scope_repo_cs.find_by_id(id);
    }

    static async find_by_slug(slug: string) {
        log.debug('find_by_slug', { slug });
        return _scope_repo_cs.find_one_q({ where: { slug } });
    }

    /**
     * Docker-style resolution: accepts @slug, slug, or UUID.
     * Returns the scope or throws 404.
     */
    static async resolve(ref: string): Promise<Scope> {
        log.debug('resolve', { ref });
        const slug = ref.startsWith('@') ? ref.slice(1) : ref;
        const where_clause = is_uuid(ref)
            ? { [Op.or]: [{ id: ref }, { slug }] }
            : { slug };
        const scope = await _scope_repo_cs.find_one_q({ where: where_clause });
        if (!scope) throw ApiError.not_found(`Scope '${ref}' not found`);
        return scope;
    }

    static async list_by_org_ids(org_ids: string[]): Promise<Scope[]> {
        log.debug('list_by_org_ids', { count: org_ids.length });
        if (org_ids.length === 0) return [];
        return _scope_repo_cs.find_all_q({
            where: { org_id: { [Op.in]: org_ids } },
            order: [['slug', 'ASC']],
        });
    }
}
