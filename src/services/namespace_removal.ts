/**
 * Deleting what owns a name in the shared name space (orgs, users).
 *
 * `orgs/delete`, `users/delete` and the invite sweep soft-delete
 * ({@link soft_delete_org}, {@link soft_delete_user}): the rows stay with
 * `deleted_at` set, so the name stays taken, history is kept and a site admin
 * can restore the same row (ReactivationService). Every function runs inside
 * the caller's transaction; call {@link RealmService.after_org_realms_removed}
 * after commit with the realms they return.
 */

import { Op, type Transaction } from 'sequelize';
import { RealmService } from './realm.service.js';

type Realm_ref = { id: string; slug: string };

/** What {@link soft_delete_user} changed (sent back to the caller and written to audit). */
export interface User_removal {
    /** Slug of the user's account org, soft-deleted with them (null when they have none). */
    account_org: string | null;
    /** Realms of the account org, soft-deleted with it. */
    realms: Realm_ref[];
    /** Memberships of other orgs, now marked deleted. */
    org_memberships: number;
    /** Realm memberships, now marked deleted. */
    realm_memberships: number;
    tokens_revoked: number;
    invites_revoked: number;
}

/**
 * Soft-deletes an org inside `t`: the org gets `deleted_at` and status
 * `deleted`, its memberships are marked deleted (member lists show them as
 * former members), its scope members are removed, its pending invites are
 * revoked, and its live realms are soft-deleted with the same timestamp and
 * their slugs kept (realm memberships soft-deleted with the same timestamp,
 * pending realm invites revoked, users whose default realm it was detached).
 * Scopes, roles, channels, rules and settings stay as they are, so
 * ReactivationService can bring the org back with them. Call
 * {@link RealmService.org_delete_blocker} first.
 *
 * @param at - The deletion time; realms carry it so a restore finds them.
 * @returns The realms soft-deleted, for {@link RealmService.after_org_realms_removed} after commit.
 */
export async function soft_delete_org(org: { id: string }, t: Transaction, at: Date = new Date()): Promise<Realm_ref[]> {
    const M = await import('../models/index.js');
    const org_id = org.id;
    await M.Org.update({ deleted_at: at, status: 'deleted' } as never, { where: { id: org_id }, transaction: t });
    await M.OrgMember.update({ deleted_at: at } as never, { where: { org_id, deleted_at: null }, transaction: t });
    await M.AccountInvite.update({ status: 'revoked' } as never, { where: { org_id, status: 'pending' }, transaction: t });
    const scope_ids = (await M.Scope.findAll({ where: { org_id }, attributes: ['id'], raw: true, transaction: t })).map((x) => x.id);
    if (scope_ids.length) await M.ScopeMember.destroy({ where: { scope_id: { [Op.in]: scope_ids } }, transaction: t });

    const realms = await M.Realm.findAll({ where: { org_id, deleted: false }, transaction: t });
    if (!realms.length) return [];
    const realm_id = { [Op.in]: realms.map((r) => r.id) };
    await M.RealmMember.unscoped().update({ deleted_at: at } as never, { where: { realm_id, deleted_at: null }, transaction: t });
    await M.RealmInvite.update({ status: 'revoked' } as never, { where: { realm_id, status: 'pending' }, transaction: t });
    await M.User.update({ default_realm_id: null } as never, { where: { default_realm_id: realm_id } as never, transaction: t });
    await M.Realm.update(
        { deleted: true, deleted_at: at.getTime(), updated_at: at.getTime() } as never,
        { where: { id: realm_id }, transaction: t },
    );
    return realms.map((r) => ({ id: r.id, slug: r.slug }));
}

/**
 * Active org members that hold the owner role (system role `owner`, or a
 * `owner`/`admin` in the `role` text column with no role id). A pending owner (open owner
 * invite) does not count.
 */
async function owner_ids(org_id: string): Promise<string[]> {
    const M = await import('../models/index.js');
    const owner_role = await M.OrgRole.findOne({ where: { org_id, slug: 'owner' }, attributes: ['id'], raw: true });
    const members = await M.OrgMember.findAll({ where: { org_id, status: 'active', deleted_at: null }, attributes: ['user_id', 'role', 'role_id'], raw: true });
    return members
        .filter((m) => (owner_role && m.role_id === owner_role.id) || (!m.role_id && (m.role === 'owner' || m.role === 'admin')))
        .map((m) => String(m.user_id));
}

/** The user's account org (slug = username), live or not; null for a user without a username or org. */
async function account_org_of(user: { username: string | null }, t?: Transaction) {
    if (!user.username) return null;
    const M = await import('../models/index.js');
    return M.Org.findOne({ where: { slug: user.username }, attributes: ['id', 'slug', 'deleted_at'], raw: true, transaction: t });
}

/**
 * The orgs that stop `users/delete` under the ownership rule: every live org
 * other than the user's account org that they own (an active owner
 * membership, or `orgs.owner_id` of an org that is not waiting for its
 * owner), plus the account org itself when it has another owner. An open
 * owner invite does not make the user an owner. Empty when the user may be
 * deleted on this rule.
 */
export async function orgs_blocking_user_delete(user: { id: string; username: string | null }): Promise<Array<{ slug: string }>> {
    const M = await import('../models/index.js');
    const account = await account_org_of(user);
    const candidates = new Map<string, string>();
    const memberships = await M.OrgMember.findAll({ where: { user_id: user.id, status: 'active', deleted_at: null }, attributes: ['org_id'], raw: true });
    const pointed = await M.Org.findAll({
        where: { owner_id: user.id, deleted_at: null, status: { [Op.ne]: 'waiting_for_owner' } }, attributes: ['id', 'slug'], raw: true,
    });
    for (const o of pointed) candidates.set(String(o.id), o.slug);
    for (const { org_id } of memberships) {
        if (candidates.has(String(org_id))) continue;
        if ((await owner_ids(String(org_id))).includes(String(user.id))) {
            const org = await M.Org.findOne({ where: { id: org_id, deleted_at: null }, attributes: ['slug'], raw: true });
            if (org) candidates.set(String(org_id), org.slug);
        }
    }
    const out: Array<{ slug: string }> = [];
    for (const [org_id, slug] of candidates) {
        if (account && String(account.id) === org_id) continue;
        out.push({ slug });
    }
    if (account && !account.deleted_at) {
        const owners = await owner_ids(String(account.id));
        if (owners.some((id) => id !== String(user.id))) out.push({ slug: account.slug });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Why `users/delete` must not delete this user, apart from org ownership
 * ({@link orgs_blocking_user_delete}), or `null`. Nothing is changed.
 *
 *   - teams they authored, or teams in a scope they own or of their account org;
 *   - other members in their account org (it is their account; remove those first);
 *   - a realm of their account org with a run in progress, an active dispatch job
 *     or a daemon ({@link RealmService.org_delete_blocker}).
 */
export async function user_delete_blocker(user: { id: string; username: string | null }): Promise<string | null> {
    const M = await import('../models/index.js');
    const name = user.username ?? user.id;
    const authored = await M.Team.count({ where: { author_id: user.id } });
    if (authored > 0) return `User ${name} authored ${authored} team(s) — delete or transfer them first`;

    const account = await account_org_of(user);
    const personal = account && !account.deleted_at ? account : null;
    const scope_where = personal
        ? { [Op.or]: [{ owner_id: user.id }, { org_id: personal.id }] }
        : { owner_id: user.id };
    const scopes = (await M.Scope.findAll({ where: scope_where, attributes: ['slug'], raw: true })).map((s) => s.slug);
    if (scopes.length) {
        const in_scopes = await M.Team.count({ where: { scope: { [Op.in]: scopes } } });
        if (in_scopes > 0) return `User ${name} owns ${in_scopes} team(s) in scope ${scopes.join(', ')} — delete or transfer them first`;
    }

    if (personal) {
        const others = await M.OrgMember.count({ where: { org_id: personal.id, user_id: { [Op.ne]: user.id }, status: 'active', deleted_at: null } });
        if (others > 0) return `Personal org ${personal.slug} has ${others} other member(s) — remove them first`;
        const realm_blocker = await RealmService.org_delete_blocker(String(personal.id));
        if (realm_blocker) return realm_blocker;
    }
    return null;
}

/**
 * Soft-deletes a user inside `t` (check {@link orgs_blocking_user_delete} and
 * {@link user_delete_blocker} first): the user gets `deleted_at`, their
 * account org is soft-deleted with them ({@link soft_delete_org}, same
 * timestamp), their other org and realm memberships are soft-deleted with
 * the same timestamp, their scope memberships are removed, their tokens are
 * revoked and the invites they sent that are still pending are revoked.
 *
 * Kept: the user row (username and email stay taken), their scopes, drafts,
 * settings and channels, and all history (runs, events, reviews, audit).
 *
 * @param at - The deletion time (shared with the account org and its realms).
 */
export async function soft_delete_user(user: { id: string; username: string | null }, t: Transaction, at: Date = new Date()): Promise<User_removal> {
    const M = await import('../models/index.js');
    const user_id = user.id;
    const out: User_removal = { account_org: null, realms: [], org_memberships: 0, realm_memberships: 0, tokens_revoked: 0, invites_revoked: 0 };

    const account = await account_org_of(user, t);
    if (account && !account.deleted_at) {
        out.realms = await soft_delete_org({ id: String(account.id) }, t, at);
        out.account_org = account.slug;
    }

    [out.org_memberships] = await M.OrgMember.update({ deleted_at: at } as never, { where: { user_id, deleted_at: null }, transaction: t });
    await M.ScopeMember.destroy({ where: { user_id }, transaction: t });
    [out.realm_memberships] = await M.RealmMember.unscoped().update(
        { deleted_at: at } as never,
        { where: { member_type: 'user', member_id: user_id, deleted_at: null }, transaction: t },
    );
    [out.tokens_revoked] = await M.ApiToken.update({ revoked_at: at } as never, { where: { user_id, revoked_at: null }, transaction: t });
    const [account_invites] = await M.AccountInvite.update({ status: 'revoked' } as never, { where: { invited_by: user_id, status: 'pending' }, transaction: t });
    const [realm_invites] = await M.RealmInvite.update({ status: 'revoked' } as never, { where: { invited_by: user_id, status: 'pending' }, transaction: t });
    out.invites_revoked = account_invites + realm_invites;

    await M.User.update({ deleted_at: at } as never, { where: { id: user_id }, transaction: t });
    return out;
}
