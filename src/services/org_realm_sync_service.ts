/**
 * Org → Realm membership helpers.
 *
 * Realm membership is always explicit. The only automatic behavior is
 * cascade-revoke: removing a user from an org revokes their access to
 * all org realms (you can't be in a realm without being in the org).
 *
 * Granting realm access is an intentional admin action — either
 * per-realm or via the bulk "add to all org realms" convenience.
 */

import { randomUUID } from 'node:crypto';

import { RealmRepository } from '../repositories/realm_repository.js';
import { RealmMemberRepository } from '../repositories/realm_member_repository.js';

const _realm_repo_ors = new RealmRepository();
const _realm_member_repo_ors = new RealmMemberRepository();
import type { Realm_member_role } from '../models/realm_member.model.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('org_realm_sync');

export class OrgRealmSyncService {

    /**
     * Cascade-revoke: remove a user from every realm belonging to the
     * given org. Skips realms the user owns (personal defaults).
     */
    static async sync_member_removed(
        org_id: string,
        user_id: string,
    ): Promise<number> {
        const realms = await _realm_repo_ors.find_all_q({
            where: { org_id, deleted: false },
            attributes: ['id', 'owner_user_id'],
        });

        const user_id_str = String(user_id);
        let revoked = 0;

        for (const realm of realms) {
            if (realm.owner_user_id === user_id_str) continue;

            const removed = await _realm_member_repo_ors.delete_where_q({
                where: { realm_id: realm.id, member_type: 'user', member_id: user_id_str },
            });
            if (removed > 0) revoked += 1;
        }

        log.info('sync_member_removed', { org_id, user_id, revoked });
        return revoked;
    }

    /**
     * Explicit bulk action: add a user to specific org realms.
     * Called by the admin when granting realm access at invite time
     * or via the "add to all realms" convenience button.
     * Existing memberships are left untouched (never downgrades).
     */
    static async bulk_add_to_realms(
        user_id: string,
        realm_ids: string[],
        role: Realm_member_role = 'member',
    ): Promise<number> {
        const user_id_str = String(user_id);
        let granted = 0;

        for (const realm_id of realm_ids) {
            const existing = await _realm_member_repo_ors.find_one_q({
                where: { realm_id, member_type: 'user', member_id: user_id_str },
            });
            if (existing) continue;

            await _realm_member_repo_ors.create_one({
                id: randomUUID(),
                realm_id,
                member_type: 'user',
                member_id: user_id_str,
                role,
                created_at: Date.now(),
            });
            granted += 1;
        }

        log.info('bulk_add_to_realms', { user_id, realm_count: realm_ids.length, granted });
        return granted;
    }

    /**
     * List all non-deleted realm ids belonging to an org.
     * Used by the frontend to populate the "add to realms" picker.
     */
    static async list_org_realm_ids(org_id: string): Promise<string[]> {
        const realms = await _realm_repo_ors.find_all_q({
            where: { org_id, deleted: false },
            attributes: ['id'],
        });
        return realms.map((r) => r.id);
    }
}
