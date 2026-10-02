/**
 * A user's account org: the org whose slug is their username, which they own.
 * Signup, users/new, accepting an invite as a new person, password links and
 * the personal-org helpers all create it here, so every account org gets the
 * same default roles, owner membership (owner role), and default channels and
 * rules (OrgSeedService).
 */

import type { Transaction } from 'sequelize';

import { normalize_name } from '../lib/namespace.js';
import { Org, OrgMember, OrgRole } from '../models/index.js';
import { seed_default_roles_for_org } from '../models/migrations/migrate_org_roles.js';
import { OrgSeedService } from './org_seed.service.js';

/** The account org of a user, and whether this call created it. */
export interface AccountOrg {
    id: string;
    created: boolean;
}

/**
 * Returns the user's account org, creating it inside `t` when missing: the
 * org (active, owned by the user), its default roles, the user's active owner
 * membership, and its default channels and rules. An existing org (live or
 * soft-deleted) is returned as it is; a missing membership of the user is
 * added as owner.
 *
 * @param user_id - The account's user.
 * @param username - The account's username (the org's slug).
 * @param t - The caller's transaction.
 */
export async function ensure_account_org(user_id: string, username: string, t: Transaction): Promise<AccountOrg> {
    const slug = normalize_name(username);
    if (!slug) throw new Error('username required for an account org');
    const existing = await Org.findOne({ where: { slug }, attributes: ['id'], raw: true, transaction: t });
    if (existing) {
        const member = await OrgMember.findOne({ where: { org_id: existing.id, user_id }, attributes: ['user_id'], raw: true, transaction: t });
        if (!member) await add_owner(String(existing.id), user_id, t);
        return { id: String(existing.id), created: false };
    }
    const now = new Date();
    const org = await Org.create({ slug, display_name: slug, owner_id: user_id, activated_at: now }, { transaction: t });
    await seed_default_roles_for_org(org.id, t);
    await OrgSeedService.seed_org(org.id, { account: true, transaction: t });
    await add_owner(org.id, user_id, t);
    return { id: org.id, created: true };
}

/** Adds the user as an active member holding the org's owner role. */
async function add_owner(org_id: string, user_id: string, t: Transaction): Promise<void> {
    await seed_default_roles_for_org(org_id, t);
    const owner_role = await OrgRole.findOne({ where: { org_id, slug: 'owner' }, attributes: ['id'], raw: true, transaction: t });
    await OrgMember.create(
        { org_id, user_id, role: 'admin', role_id: owner_role ? String(owner_role.id) : null, status: 'active', joined_at: new Date() },
        { transaction: t },
    );
}
