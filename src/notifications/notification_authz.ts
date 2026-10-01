/**
 * Notification route helpers.
 *
 * Access to channels, rules and custom events is decided by the route policy
 * (`auth/route_policy/table.ts`): realm operate + `rules.manage.realm` /
 * `channels.manage.realm`, or the org permission for org-level rows.
 */

import type { Request } from 'express';

import { ApiError } from '../lib/api_error.js';

export function require_authenticated_user_id(req: Request): string {
    const user_id = req.auth?.user?.id?.trim();
    if (!user_id) throw ApiError.unauthorized('Authentication required');
    return user_id;
}
