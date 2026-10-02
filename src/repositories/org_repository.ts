/**
 * Orgs. A soft-deleted org (`deleted_at` set) keeps its row and slug; reads
 * skip it unless they say otherwise ({@link OrgRepository.find_by_slug} for the
 * name space, {@link OrgRepository.find_by_id_with_deleted}).
 */

import { Org } from '../models/index.js';
import { BaseRepository } from './base_repository.js';

const ORG_ATTRS = ['id', 'slug', 'display_name', 'created_at', 'status', 'owner_id', 'deleted_at'] as const;

export class OrgRepository extends BaseRepository<Org> {
    protected readonly model = Org;

    /**
     * Finds a live org by id (null when unknown or soft-deleted), with the
     * lifecycle fields `status`, `owner_id` and `deleted_at`.
     */
    async find_by_id(id: string) {
        return Org.findOne({ where: { id, deleted_at: null }, attributes: [...ORG_ATTRS], raw: true });
    }

    /** {@link find_by_id}, soft-deleted orgs included (`deleted_at` tells which). */
    async find_by_id_with_deleted(id: string) {
        return Org.findOne({ where: { id }, attributes: [...ORG_ATTRS], raw: true });
    }

    /** Finds an org by slug, deleted or not (`deleted_at` tells which). */
    async find_by_slug(slug: string) {
        return Org.findOne({ where: { slug }, attributes: ['id', 'slug', 'display_name', 'created_at', 'status', 'deleted_at', 'activated_at'], raw: true });
    }

    async create(slug: string, display_name: string): Promise<string> {
        const row = await Org.create({ slug, display_name });
        return row.id;
    }

    async update_display_name(id: string, display_name: string): Promise<void> {
        await Org.update({ display_name }, { where: { id } });
    }

    async delete_by_id(id: string): Promise<number> {
        return Org.destroy({ where: { id } });
    }
}
