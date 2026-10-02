/**
 * Reactivating soft-deleted orgs and users: the `reactivate: true` path of
 * the create routes (orgs/new, invitations/create, users/new) after a
 * `409 deleted`. The same row and id come back with what was soft-deleted
 * with them (see namespace_removal.ts). Org memberships of former members do
 * not; realm memberships come back for daemons and groups and for people
 * who are org members again.
 *
 * Only a site admin may reactivate. Both restore methods run inside the
 * caller's transaction; the caller sends the new owner invite or setup link,
 * whose event goes out after commit.
 */

import { Op, type Transaction } from 'sequelize';
import { ApiError } from '../errors/api_error.js';
import { get_logger } from '../lib/log.js';
import type { AuthContext } from '../schemas/auth_types.js';
import type { OrgStatus } from '../models/org.model.js';
import { OrgSeedService } from './org_seed.service.js';

const log = get_logger('svc.reactivation');

/** What {@link ReactivationService.restore_org} brings back. */
export interface RestoredOrg {
    id: string;
    slug: string;
    display_name: string;
    /** Always `waiting_for_owner`: the org needs a new owner invite. */
    status: OrgStatus;
    /** Ids of the realms restored with the org. */
    realm_ids: string[];
}

/** What {@link ReactivationService.restore_user} brings back. */
export interface RestoredUser {
    id: string;
    username: string | null;
    email: string;
    display_name: string;
    /** Always `invited`: the user sets a new password through a setup link or invite. */
    status: 'invited';
    /** The user's account org, restored with them (null when they had none). */
    account_org_id: string | null;
}

/**
 * Restores soft-deleted orgs and users in place (same id, same name).
 */
export class ReactivationService {
    /**
     * Requires a site admin (the only caller allowed to send `reactivate: true`).
     *
     * @throws ApiError 403 forbidden for anyone else
     */
    assert_can_reactivate(auth: AuthContext): void {
        if (!auth.user || auth.user.role !== 'admin') {
            throw new ApiError('forbidden', 'Only a site admin can reactivate a deleted org or user', 403);
        }
    }

    /**
     * Restores a soft-deleted org inside `t`: clears `deleted_at`, sets status
     * `waiting_for_owner` and `owner_id` NULL, brings back the realms deleted
     * with it and their daemon and group memberships, and seeds the default channels
     * and rules only if the org was never seeded. Scopes, roles, channels,
     * rules and settings were kept by the delete and are there again. Former
     * members stay deleted and are not invited again; the caller sends the
     * new owner invite (and sets `owner_id`).
     *
     * @param auth - The caller (site admin).
     * @param org_id - The deleted org (`details.id` of the `409 deleted`).
     * @param t - The caller's transaction.
     * @throws ApiError 403 forbidden; 404 not_found; 409 conflict when the org
     *   is not deleted or is a user's account org (restore the user instead)
     */
    async restore_org(auth: AuthContext, org_id: string, t: Transaction): Promise<RestoredOrg> {
        this.assert_can_reactivate(auth);
        const M = await import('../models/index.js');
        const org = await M.Org.findOne({ where: { id: org_id }, transaction: t, lock: t.LOCK.UPDATE });
        if (!org) throw new ApiError('not_found', 'Org not found', 404);
        if (!org.deleted_at) throw new ApiError('conflict', `Org ${org.slug} is not deleted`, 409, { kind: 'org', id: org.id });
        const account_user = await M.User.findOne({ where: { username: org.slug }, attributes: ['id'], raw: true, transaction: t });
        if (account_user) {
            throw new ApiError('conflict', `Org ${org.slug} is the account of user ${org.slug}; reactivate the user instead`, 409, { kind: 'user', id: String(account_user.id) });
        }

        const deleted_at = org.deleted_at;
        const realm_ids = await this._restore_org_rows(org, 'waiting_for_owner', null, t);
        await this._restore_realm_memberships(org.id, realm_ids, deleted_at, t);
        // An org seeded before keeps its channels and rules as the owners left them.
        if (!org.notifications_seeded_at) await OrgSeedService.seed_org(org.id, { account: false, transaction: t });
        log.info('org_restored', { org_id: org.id, slug: org.slug, realms: realm_ids.length, actor_id: auth.user!.id });
        return { id: org.id, slug: org.slug, display_name: org.display_name, status: 'waiting_for_owner', realm_ids };
    }

    /**
     * Restores a soft-deleted user inside `t` (same id, username and email):
     * clears `deleted_at`, sets status `invited` with no password (the caller
     * sends a setup link or an invite) and clears any suspension. Their
     * account org comes back active with its realms, owned by them again
     * (owner, scope and realm memberships restored).
     * Memberships of other orgs stay deleted and tokens stay revoked.
     *
     * @param auth - The caller (site admin).
     * @param user_id - The deleted user (`details.id` of the `409 deleted`).
     * @param t - The caller's transaction.
     * @throws ApiError 403 forbidden; 404 not_found; 409 conflict when the user is not deleted
     */
    async restore_user(auth: AuthContext, user_id: string, t: Transaction): Promise<RestoredUser> {
        this.assert_can_reactivate(auth);
        const M = await import('../models/index.js');
        const user = await M.User.findOne({ where: { id: user_id }, transaction: t, lock: t.LOCK.UPDATE });
        if (!user) throw new ApiError('not_found', 'User not found', 404);
        if (!user.deleted_at) throw new ApiError('conflict', `User ${user.username ?? user.email} is not deleted`, 409, { kind: 'user', id: user.id });

        await M.User.update(
            { deleted_at: null, status: 'invited', password_hash: null, suspended_at: null, suspended_reason: '' } as never,
            { where: { id: user.id }, transaction: t },
        );

        let account_org_id: string | null = null;
        const account = user.username
            ? await M.Org.findOne({ where: { slug: user.username, deleted_at: { [Op.ne]: null } }, transaction: t, lock: t.LOCK.UPDATE })
            : null;
        if (account) {
            const deleted_at = account.deleted_at!;
            const realm_ids = await this._restore_org_rows(account, 'active', user.id, t);
            await M.OrgMember.update(
                { deleted_at: null } as never,
                { where: { org_id: account.id, user_id: user.id, deleted_at }, transaction: t },
            );
            await this._restore_realm_memberships(account.id, realm_ids, deleted_at, t);
            const own_scopes = await M.Scope.findAll({ where: { org_id: account.id, owner_id: user.id }, attributes: ['id'], raw: true, transaction: t });
            for (const scope of own_scopes) {
                await M.ScopeMember.findOrCreate({ where: { scope_id: scope.id, user_id: user.id }, transaction: t });
            }
            if (!account.notifications_seeded_at) await OrgSeedService.seed_org(account.id, { account: true, transaction: t });
            account_org_id = account.id;
        }

        log.info('user_restored', { user_id: user.id, account_org_id, actor_id: auth.user!.id });
        return {
            id: user.id,
            username: user.username ?? null,
            email: user.email,
            display_name: user.display_name,
            status: 'invited',
            account_org_id,
        };
    }

    /**
     * Brings back the realm memberships removed with an org (same
     * timestamp) in the realms restored with it: daemons and groups, and users
     * who are active members of the org again. Pending memberships went with
     * their revoked invites and stay removed.
     */
    private async _restore_realm_memberships(org_id: string, realm_ids: string[], deleted_at: Date, t: Transaction): Promise<void> {
        if (!realm_ids.length) return;
        const M = await import('../models/index.js');
        const members = await M.OrgMember.findAll({ where: { org_id, status: 'active', deleted_at: null }, attributes: ['user_id'], raw: true, transaction: t });
        await M.RealmMember.unscoped().update(
            { deleted_at: null } as never,
            {
                where: {
                    realm_id: { [Op.in]: realm_ids },
                    status: 'active',
                    deleted_at,
                    [Op.or]: [
                        { member_type: { [Op.ne]: 'user' } },
                        { member_type: 'user', member_id: { [Op.in]: members.map((m) => String(m.user_id)) } },
                    ],
                },
                transaction: t,
            },
        );
    }

    /**
     * Clears `deleted_at` on an org and the realms soft-deleted with it (same
     * timestamp); a realm whose slug was taken again in the org stays deleted.
     *
     * @returns The ids of the realms restored.
     */
    private async _restore_org_rows(
        org: { id: string; deleted_at: Date | null },
        status: OrgStatus,
        owner_id: string | null,
        t: Transaction,
    ): Promise<string[]> {
        const M = await import('../models/index.js');
        const deleted_ms = org.deleted_at!.getTime();
        const realms = await M.Realm.findAll({ where: { org_id: org.id, deleted: true, deleted_at: deleted_ms }, transaction: t });
        const restored: string[] = [];
        for (const realm of realms) {
            const taken = await M.Realm.count({ where: { org_id: org.id, slug: realm.slug, deleted: false }, transaction: t });
            if (taken > 0) {
                log.warn('realm_restore_skipped', { realm_id: realm.id, slug: realm.slug, reason: 'slug_taken' });
                continue;
            }
            await realm.update({ deleted: false, deleted_at: null, updated_at: Date.now() }, { transaction: t });
            restored.push(realm.id);
        }

        await M.Org.update(
            { deleted_at: null, status, owner_id } as never,
            { where: { id: org.id }, transaction: t },
        );
        return restored;
    }
}
