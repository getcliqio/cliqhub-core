import { ScopeMember, Scope } from '../db/models/index.js';
import { Op } from 'sequelize';

export class ScopeMemberRepository {
    async find_by_scope_and_user(scope_id: string, user_id: string) {
        return ScopeMember.findOne({ where: { scope_id, user_id }, raw: true });
    }

    async create(scope_id: string, user_id: string): Promise<void> {
        await ScopeMember.create({ scope_id, user_id });
    }

    async create_on_conflict_ignore(scope_id: string, user_id: string): Promise<void> {
        await ScopeMember.findOrCreate({
            where: { scope_id, user_id },
            defaults: { scope_id, user_id },
        });
    }

    async delete_by_scope_and_user(scope_id: string, user_id: string): Promise<number> {
        return ScopeMember.destroy({ where: { scope_id, user_id } });
    }

    async delete_by_scope_id(scope_id: string): Promise<void> {
        await ScopeMember.destroy({ where: { scope_id } });
    }

    async delete_by_user_and_org_scopes(user_id: string, org_id: string): Promise<void> {
        const scopes = await Scope.findAll({
            where: { org_id },
            attributes: ['id'],
            raw: true,
        });
        if (scopes.length === 0) return;
        const scope_ids = scopes.map(s => s.id);
        await ScopeMember.destroy({
            where: { user_id, scope_id: { [Op.in]: scope_ids } },
        });
    }
}
