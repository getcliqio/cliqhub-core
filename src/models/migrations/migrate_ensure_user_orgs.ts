/**
 * Personal-org helpers.
 *
 * Personal (account) orgs are created at user-creation time (signup,
 * users/new, invite accept) through `ensure_account_org`
 * (services/account_org.ts). These helpers look one up for a user, creating
 * it the same way when it is missing.
 */

import { Org, OrgMember } from '../../models/index.js';
import { get_sequelize } from '../../db/sequelize.js';
import { ensure_account_org } from '../../services/account_org.js';

/** Resolve the personal org for a user (slug === username). Creates if missing. */
export async function ensure_personal_org_for_user(
    user_id: string,
    username: string,
): Promise<Org> {
    const { id } = await get_sequelize().transaction((t) => ensure_account_org(user_id, username, t));
    return (await Org.findByPk(id))!;
}

/**
 * The user's primary org: their personal org (slug === username) when they
 * are an active member of it, else the first org they are an active member of.
 */
export async function resolve_primary_org_id_for_user(
    user_id: string,
    username?: string,
): Promise<string | null> {
    const live = { user_id, status: 'active', deleted_at: null } as const;
    if (username) {
        const slug = username.trim().toLowerCase().replace(/^@/, '');
        const personal = await Org.findOne({ where: { slug, deleted_at: null } });
        if (personal) {
            const m = await OrgMember.findOne({ where: { org_id: personal.id, ...live } });
            if (m) return personal.id;
        }
    }

    const any = await OrgMember.findOne({
        where: live,
        order: [['org_id', 'ASC']],
    });
    return any?.org_id ?? null;
}
