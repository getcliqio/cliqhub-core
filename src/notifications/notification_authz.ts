/**
 * Notification authorization helpers.
 *
 * Phase 3: uses the permission-based model for org-level operations,
 * with fallback to legacy checks when org context is unavailable.
 */

import { Op } from 'sequelize';
import type { Request } from 'express';

import { ApiError } from '../lib/api_error.js';
import { RealmService } from '../services/realm.service.js';
import { OrgMember } from '../db/models/index.js';
import { require_permission } from '../auth/permissions.js';

export function require_authenticated_user_id(req: Request): string {
    const user_id = req.user?.user_id?.trim();
    if (!user_id) throw ApiError.unauthorized('Authentication required');
    return user_id;
}

/**
 * Org-level channel/rule mutate gate.
 * Uses role-based `channels.manage` permission when org context is available,
 * falls back to legacy admin check otherwise.
 */
export async function require_account_notification_admin(req: Request): Promise<string> {
    const hub_user = req.auth?.user;
    if (!hub_user) throw ApiError.unauthorized('Authentication required');

    const user_id = String(hub_user.id);
    if (hub_user.role === 'admin') return user_id;

    const org_id = req.auth?.current_org_id ?? req.user?.current_org_id;
    if (org_id) {
        await require_permission(org_id, hub_user.id, 'channels.manage', {
            site_role: hub_user.role,
        });
        return user_id;
    }

    // Legacy fallback: require admin role on any org
    const org_ids = (req.user?.org_ids ?? [])
        .map((id) => String(id).trim())
        .filter((id) => id.length > 0);
    if (org_ids.length === 0) {
        throw ApiError.forbidden('Account admin required to manage notification channels');
    }

    const membership = await OrgMember.findOne({
        where: {
            user_id: hub_user.id,
            org_id: { [Op.in]: org_ids },
            role: 'admin',
        },
    });
    if (!membership) {
        throw ApiError.forbidden('Account admin required to manage notification channels');
    }
    return user_id;
}

/**
 * Realm-level notification admin: uses `rules.manage.realm` permission
 * when org context is available, falls back to realm admin check.
 */
export async function require_realm_notification_admin(
    realm_id: string,
    user_id: string,
    req?: Request,
): Promise<void> {
    const org_id = req?.auth?.current_org_id ?? req?.user?.current_org_id;
    if (org_id) {
        const site_role = req?.auth?.user?.role ?? req?.user?.role;
        await require_permission(String(org_id), String(user_id), 'rules.manage.realm', {
            site_role,
        });
        return;
    }
    await RealmService.require_admin(realm_id, user_id);
}

export async function require_realm_notification_member(
    realm_id: string,
    user_id: string,
): Promise<void> {
    await RealmService.assert_member(realm_id, user_id);
}
