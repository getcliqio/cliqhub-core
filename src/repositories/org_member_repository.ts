import { OrgMember, OrgRole, Org, User } from '../models/index.js';
import { literal } from 'sequelize';
import { BaseRepository } from './base_repository.js';

export class OrgMemberRepository extends BaseRepository<OrgMember> {
    protected readonly model = OrgMember;
    async find_orgs_by_user(user_id: string) {
        return OrgMember.findAll({
            where: { user_id },
            include: [{ model: Org, attributes: ['slug'] }],
            raw: true,
            nest: true,
        }).then(rows => rows.map(r => ({
            slug: (r as any).org?.slug ?? '',
            role: r.role,
            org_id: r.org_id,
        })));
    }

    async find_by_org_and_user(org_id: string, user_id: string) {
        return OrgMember.findOne({
            where: { org_id, user_id },
            attributes: ['org_id', 'user_id', 'role', 'role_id'],
            raw: true,
        });
    }

    async list_members_by_org(org_id: string) {
        const rows = await OrgMember.findAll({
            where: { org_id },
            include: [{ model: User, attributes: ['username', 'display_name', 'email'] }],
            order: [['role', 'DESC'], [User, 'username', 'ASC']],
            raw: true,
            nest: true,
        });
        return rows.map((r: any) => ({
            user_id: r.user_id,
            username: r.User?.username,
            display_name: r.User?.display_name,
            email: r.User?.email,
            role: r.role,
            role_id: r.role_id ?? null,
        }));
    }

    async count_admins_by_org(org_id: string): Promise<number> {
        return OrgMember.count({ where: { org_id, role: 'admin' } });
    }

    /**
     * Add a member with the org role whose slug matches `role` (`member`, `admin`, …).
     * `role_id` is what permission checks read; without it every check says
     * "No role assigned" (B1).
     */
    async create(org_id: string, user_id: string, role: string): Promise<void> {
        const org_role = await OrgRole.findOne({ where: { org_id, slug: role }, attributes: ['id'], raw: true });
        await OrgMember.create({ org_id, user_id, role, role_id: org_role?.id ?? null });
    }

    async update_role(org_id: string, user_id: string, role: string): Promise<void> {
        await OrgMember.update({ role }, { where: { org_id, user_id } });
    }

    async delete_by_org_and_user(org_id: string, user_id: string): Promise<void> {
        await OrgMember.destroy({ where: { org_id, user_id } });
    }

    async list_my_orgs(user_id: string) {
        const rows = await OrgMember.findAll({
            where: { user_id },
            include: [{
                model: Org,
                attributes: [
                    'id', 'slug', 'display_name',
                    [literal('(SELECT count(*) FROM org_members om2 WHERE om2.org_id = "Org"."id")'), 'member_count'],
                    [literal('(SELECT count(*) FROM scopes s WHERE s.org_id = "Org"."id")'), 'scope_count'],
                ],
            }],
            order: [[Org, 'slug', 'ASC']],
            raw: true,
            nest: true,
        });
        return rows.map((r: any) => ({
            id: r.Org?.id,
            slug: r.Org?.slug,
            display_name: r.Org?.display_name,
            role: r.role,
            member_count: r.Org?.member_count,
            scope_count: r.Org?.scope_count,
        }));
    }

    async list_admins_by_org(org_id: string) {
        return OrgMember.findAll({
            where: { org_id, role: 'admin' },
            attributes: ['user_id'],
            raw: true,
        });
    }
}
