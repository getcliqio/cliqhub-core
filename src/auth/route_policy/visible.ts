/**
 * Realms a user can see, by the same rules as the route policy engine:
 *   realm member (member=view, operator=operate, admin=admin)
 *   + every realm of an org where the user is owner or admin (admin)
 *   + realms the user owns (admin)
 * then, when `perm` is given, drop realms whose org role lacks it (org members
 * only; realm guests are judged on their realm role alone).
 *
 * Used by list endpoints so a filter can never widen what a caller sees (S5).
 */

import { Op } from 'sequelize';

import { OrgMember, OrgRole, Realm, RealmMember } from '../../models/index.js';
import { DEFAULT_ROLES } from '../permissions.js';
import { LEVEL_RANK, type Level, type Permission } from './policy.js';

const ROLE_LEVEL: Record<string, Level> = { admin: 'admin', operator: 'operate', member: 'view' };

interface OrgRoleRow { slug: string; is_system: boolean; permissions: string[] }

/** The user's role in one org (null when not a member). Legacy rows fall back to the `role` column. */
export async function org_standing(org_id: string, user_id: string): Promise<OrgRoleRow | null> {
    return (await org_roles_for_user(user_id)).get(org_id) ?? null;
}

async function org_roles_for_user(user_id: string): Promise<Map<string, OrgRoleRow>> {
    // Pending memberships (open invites) grant nothing until accepted.
    const members = await OrgMember.findAll({ where: { user_id, status: 'active', deleted_at: null }, attributes: ['org_id', 'role', 'role_id'], raw: true }) as unknown as
        Array<{ org_id: string; role: string; role_id: string | null }>;
    const role_ids = members.map((m) => m.role_id).filter((x): x is string => Boolean(x));
    const roles = role_ids.length
        ? await OrgRole.findAll({ where: { id: { [Op.in]: role_ids } }, attributes: ['id', 'slug', 'is_system', 'permissions'], raw: true }) as unknown as
            Array<{ id: string; slug: string; is_system: boolean; permissions: string[] | null }>
        : [];
    const by_id = new Map(roles.map((r) => [r.id, r]));
    const out = new Map<string, OrgRoleRow>();
    for (const m of members) {
        const r = m.role_id ? by_id.get(m.role_id) : undefined;
        if (r) {
            out.set(m.org_id, { slug: r.slug, is_system: Boolean(r.is_system), permissions: r.permissions ?? [] });
        } else {
            const legacy = DEFAULT_ROLES.find((d) => d.slug === m.role) ?? DEFAULT_ROLES.find((d) => d.slug === 'member')!;
            out.set(m.org_id, { slug: legacy.slug, is_system: legacy.is_system, permissions: [...legacy.permissions] });
        }
    }
    return out;
}

export async function visible_realm_ids(
    user_id: string,
    opts: { org_id?: string; need?: Level; perm?: Permission } = {},
): Promise<string[]> {
    const need = opts.need ?? 'view';
    const [memberships, org_roles, owned] = await Promise.all([
        RealmMember.findAll({ where: { member_type: 'user', member_id: user_id }, attributes: ['realm_id', 'role'], raw: true }) as unknown as
            Promise<Array<{ realm_id: string; role: string }>>,
        org_roles_for_user(user_id),
        Realm.findAll({ where: { owner_user_id: user_id, deleted: false }, attributes: ['id'], raw: true }) as unknown as Promise<Array<{ id: string }>>,
    ]);

    const admin_orgs = [...org_roles.entries()]
        .filter(([, r]) => r.is_system || r.slug === 'admin')
        .map(([org_id]) => org_id);

    const level = new Map<string, Level>();
    const bump = (realm_id: string, l: Level) => {
        const cur = level.get(realm_id);
        if (!cur || LEVEL_RANK[l] > LEVEL_RANK[cur]) level.set(realm_id, l);
    };
    for (const m of memberships) bump(m.realm_id, ROLE_LEVEL[m.role] ?? 'view');
    for (const r of owned) bump(r.id, 'admin');

    const candidate_ids = [...level.keys()];
    const where_or: Array<Record<string, unknown>> = [];
    if (candidate_ids.length) where_or.push({ id: { [Op.in]: candidate_ids } });
    if (admin_orgs.length) where_or.push({ org_id: { [Op.in]: admin_orgs } });
    if (where_or.length === 0) return [];

    const realms = await Realm.findAll({
        where: {
            deleted: false,
            [Op.or]: where_or,
            ...(opts.org_id ? { org_id: opts.org_id } : {}),
        },
        attributes: ['id', 'org_id'],
        raw: true,
    }) as unknown as Array<{ id: string; org_id: string | null }>;

    const out: string[] = [];
    for (const r of realms) {
        if (r.org_id && admin_orgs.includes(r.org_id)) bump(r.id, 'admin');
        const l = level.get(r.id);
        if (!l || LEVEL_RANK[l] < LEVEL_RANK[need]) continue;
        if (opts.perm && r.org_id) {
            const role = org_roles.get(r.org_id);
            if (role && !role.is_system && !role.permissions.includes(opts.perm)) continue;
        }
        out.push(r.id);
    }
    return out;
}
