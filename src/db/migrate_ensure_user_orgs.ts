/**
 * Personal-org helpers.
 *
 * Personal orgs are created at user-creation time (signup, admin-create,
 * org-create-with-new-admin, invite-accept). No boot-time backfill —
 * every creation path calls `ensure_personal_realm` which uses
 * `ensure_personal_org_for_user` below.
 */

import { Org, OrgMember } from './models/index.js';

/** Resolve the personal org for a user (slug === username). Creates if missing. */
export async function ensure_personal_org_for_user(
    user_id: string,
    username: string,
): Promise<Org> {
    const slug = username.trim().toLowerCase().replace(/^@/, '');
    if (!slug) throw new Error('username required for personal org');

    let org = await Org.findOne({ where: { slug } });
    if (!org) {
        org = await Org.create({ slug, display_name: slug });
    }

    const membership = await OrgMember.findOne({
        where: { org_id: org.id, user_id },
    });
    if (!membership) {
        await OrgMember.create({ org_id: org.id, user_id, role: 'admin' });
    }

    return org;
}

/** Prefer personal org (slug === username); else first membership. */
export async function resolve_primary_org_id_for_user(
    user_id: string,
    username?: string,
): Promise<string | null> {
    if (username) {
        const slug = username.trim().toLowerCase().replace(/^@/, '');
        const personal = await Org.findOne({ where: { slug } });
        if (personal) {
            const m = await OrgMember.findOne({
                where: { org_id: personal.id, user_id },
            });
            if (m) return personal.id;
        }
    }

    const any = await OrgMember.findOne({
        where: { user_id },
        order: [['org_id', 'ASC']],
    });
    return any?.org_id ?? null;
}
