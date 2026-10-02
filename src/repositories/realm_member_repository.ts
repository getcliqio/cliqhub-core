/**
 * Realm memberships. Reads see live, active memberships only (the model's
 * default scope). Removing a membership soft-deletes it, and adding one whose
 * row exists (former or pending) revives that row, since (realm, member type,
 * member) is unique.
 */

import type { CreateOptions, CreationAttributes, WhereOptions } from 'sequelize';

import { BaseRepository } from './base_repository.js';
import { RealmMember } from '../models/index.js';

export class RealmMemberRepository extends BaseRepository<RealmMember> {
    protected readonly model = RealmMember;

    /**
     * Adds a membership, or revives the existing row of the same realm and
     * member (former or pending) as active with the given role.
     */
    override async create_one(values: CreationAttributes<RealmMember>, options?: CreateOptions): Promise<RealmMember> {
        const all = RealmMember.unscoped();
        const key = { realm_id: values.realm_id, member_type: values.member_type, member_id: values.member_id };
        const existing = await all.findOne({ where: key, transaction: options?.transaction });
        if (!existing) return RealmMember.create({ ...values, status: 'active', deleted_at: null }, options);
        await all.update(
            { role: values.role, status: 'active', deleted_at: null },
            { where: { id: existing.id }, transaction: options?.transaction },
        );
        return (await all.findByPk(existing.id, { transaction: options?.transaction }))!;
    }

    /** Removes the matching memberships (soft delete, pending ones included). */
    override async delete_where(where: WhereOptions<RealmMember>): Promise<number> {
        return this.delete_where_q({ where });
    }

    /** {@link delete_where} with extra options (e.g. a transaction). */
    override async delete_where_q(options: { where: WhereOptions<RealmMember>; [key: string]: unknown }): Promise<number> {
        const [count] = await RealmMember.unscoped().update(
            { deleted_at: new Date() },
            { ...options, where: { ...(options.where as object), deleted_at: null } },
        );
        return count;
    }
}
