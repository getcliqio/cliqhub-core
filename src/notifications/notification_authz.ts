/**
 * Notification authorization helpers.
 *
 * NTF-ORG: account admin takes explicit `org_id` (never X-Org-Id / current_org_id SoT).
 * Realm admin resolves permission against the realm's owning org.
 */

import type { Request } from 'express';

import { ApiError } from '../lib/api_error.js';
import { RealmService } from '../services/realm.service.js';
import { Realm } from '../models/index.js';
import { require_permission } from '../auth/permissions.js';

export function require_authenticated_user_id(req: Request): string {
    const user_id = req.user?.user_id?.trim();
    if (!user_id) throw ApiError.unauthorized('Authentication required');
    return user_id;
}

/**
 * Org-level channel/rule mutate gate.
 * Uses role-based `channels.manage` for the explicit body `org_id`.
 * Site hub admins may manage any org's account channels.
 */
export async function require_account_notification_admin(
    req: Request,
    org_id: string,
): Promise<string> {
    const hub_user = req.auth?.user;
    if (!hub_user) throw ApiError.unauthorized('Authentication required');

    const user_id = String(hub_user.id);
    // Site-wide hub admin may manage account channels for any org.
    if (hub_user.role === 'admin') return user_id;

    const trimmed = org_id.trim();
    if (!trimmed) {
        throw ApiError.bad_request('org_id is required to manage account notification channels');
    }

    await require_permission(trimmed, hub_user.id, 'channels.manage', {
        site_role: hub_user.role,
    });
    return user_id;
}

/**
 * Realm-level notification admin: `rules.manage.realm` against the realm's org,
 * else fall back to realm admin membership.
 */
export async function require_realm_notification_admin(
    realm_id: string,
    user_id: string,
    req?: Request,
): Promise<void> {
    const realm = await Realm.findByPk(realm_id, { attributes: ['id', 'org_id'] });
    if (!realm) throw ApiError.not_found(`realm '${realm_id}' not found`);

    // Prefer permission check against the realm's owning org (not session header).
    if (realm.org_id) {
        try {
            const site_role = req?.auth?.user?.role ?? req?.user?.role;
            await require_permission(String(realm.org_id), String(user_id), 'rules.manage.realm', {
                site_role,
            });
            return;
        } catch {
            // Fall through to realm-admin membership (legacy / tests without org roles).
        }
    }
    await RealmService.require_admin(realm_id, user_id);
}

export async function require_realm_notification_member(
    realm_id: string,
    user_id: string,
): Promise<void> {
    await RealmService.assert_member(realm_id, user_id);
}
