/**
 * Org memberships. Removed memberships are soft-deleted (`deleted_at`) and an
 * open invite is a `pending` row: every read here sees only live, active
 * memberships except {@link OrgMemberRepository.list_members_by_org}, which
 * also lists pending and former members.
 */

import { OrgMember, OrgRole, Org, User } from '../models/index.js';
import { Op, literal } from 'sequelize';
import { BaseRepository } from './base_repository.js';
import type { OrgStatus } from '../models/org.model.js';

/** Membership state shown in member lists (`deleted` once the membership was removed). */
export type MemberListStatus = 'pending' | 'active' | 'deleted';

/** ISO string of a DB timestamp (or null). */
function iso(value: Date | string | null | undefined): string | null {
    if (value == null) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Memberships that grant access: live (not soft-deleted) and `active`. A
 * `pending` row (open invite) is not a membership until the invite is accepted.
 */
const ACTIVE = { status: 'active', deleted_at: null } as const;

export class OrgMemberRepository extends BaseRepository<OrgMember> {
    protected readonly model = OrgMember;
    async find_orgs_by_user(user_id: string) {
        return OrgMember.findAll({
            where: { user_id, ...ACTIVE },
            include: [{ model: Org, attributes: ['slug'], where: { deleted_at: null } }],
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
            where: { org_id, user_id, ...ACTIVE },
            attributes: ['org_id', 'user_id', 'role', 'role_id'],
            raw: true,
        });
    }

    /**
     * The org's members with their membership state: `active`, `pending`
     * (invited, not yet accepted) or `deleted` (a former member). An invite
     * that was declined, revoked or expired before the person ever joined is
     * not listed.
     */
    async list_members_by_org(org_id: string) {
        const rows = await OrgMember.findAll({
            where: {
                org_id,
                [Op.or]: [{ deleted_at: null }, { status: 'active' }, { joined_at: { [Op.ne]: null } }],
            },
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
            status: (r.deleted_at ? 'deleted' : r.status) as MemberListStatus,
            invited_at: iso(r.invited_at),
            joined_at: iso(r.joined_at),
            deleted_at: iso(r.deleted_at),
        }));
    }

    async count_admins_by_org(org_id: string): Promise<number> {
        return OrgMember.count({ where: { org_id, role: 'admin', ...ACTIVE } });
    }

    /**
     * Add a member with the org role whose slug matches `role` (`member`, `admin`, …).
     * `role_id` is what permission checks read; without it every check says
     * "No role assigned". A former (soft-deleted) membership of the same person
     * is revived in place, since (org_id, user_id) is the primary key.
     */
    async create(org_id: string, user_id: string, role: string): Promise<void> {
        const org_role = await OrgRole.findOne({ where: { org_id, slug: role }, attributes: ['id'], raw: true });
        const role_id = org_role?.id ?? null;
        const [revived] = await OrgMember.update(
            { role, role_id, status: 'active', deleted_at: null } as never,
            { where: { org_id, user_id } },
        );
        if (revived === 0) await OrgMember.create({ org_id, user_id, role, role_id });
    }

    async update_role(org_id: string, user_id: string, role: string): Promise<void> {
        await OrgMember.update({ role }, { where: { org_id, user_id, deleted_at: null } });
    }

    /** Removes a membership: the row is soft-deleted so member lists show the former member. */
    async delete_by_org_and_user(org_id: string, user_id: string): Promise<void> {
        await OrgMember.update({ deleted_at: new Date() } as never, { where: { org_id, user_id, deleted_at: null } });
    }

    async list_my_orgs(user_id: string) {
        const rows = await OrgMember.findAll({
            where: { user_id, ...ACTIVE },
            include: [{
                model: Org,
                where: { deleted_at: null },
                attributes: [
                    'id', 'slug', 'display_name', 'status', 'owner_id', 'deleted_at',
                    [literal('(SELECT count(*) FROM org_members om2 WHERE om2.org_id = "Org"."id" AND om2.status = \'active\' AND om2.deleted_at IS NULL)'), 'member_count'],
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
            status: r.Org?.status as OrgStatus,
            owner_id: r.Org?.owner_id ? String(r.Org.owner_id) : null,
            deleted_at: iso(r.Org?.deleted_at),
        }));
    }

    async list_admins_by_org(org_id: string) {
        return OrgMember.findAll({
            where: { org_id, role: 'admin', ...ACTIVE },
            attributes: ['user_id'],
            raw: true,
        });
    }
}
