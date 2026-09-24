/**
 * Permission vocabulary — every gateable action in CliqHub maps to
 * exactly one permission string. Roles are named bundles of these.
 *
 * Owner-only permissions (`org.delete`, `org.transfer`) cannot be
 * assigned to any role; the owner role gets all permissions implicitly.
 */

/** All permission strings recognized by the system. */
export const ALL_PERMISSIONS = [
    // ── Org Management ──────────────────────────────────────────────
    'org.settings',
    'org.members.manage',
    'org.scopes.manage',

    // ── Realm Lifecycle ─────────────────────────────────────────────
    'realms.create',
    'realms.delete',
    'realms.update',
    'realms.members.manage',
    'realms.teams.manage',
    'realms.view',

    // ── Daemon & Infrastructure ─────────────────────────────────────
    'daemons.enroll',
    'daemons.remove',
    'daemons.view',
    'tokens.manage',
    'dispatch_keys.manage',

    // ── Team Execution ──────────────────────────────────────────────
    'teams.run',
    'teams.cancel',
    'teams.inputs',
    'teams.install',
    'runs.view',

    // ── Publishing ──────────────────────────────────────────────────
    'teams.publish',
    'teams.publish.delete',
    'teams.catalog.view',

    // ── Notification Configuration ──────────────────────────────────
    'channels.manage',
    'channels.manage.realm',
    'channels.test',
    'rules.manage',
    'rules.manage.realm',
    'inbox.view',

    // ── Agent Configuration ─────────────────────────────────────────
    'agents.manage',
    'agents.manage.realm',
    'agents.view',
    'agents.reveal',

    // ── HUG Reviews ─────────────────────────────────────────────────
    'reviews.verdict',
    'reviews.view',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

/**
 * Owner-only permissions — never assignable to roles.
 * The owner role bypasses all checks.
 */
export const OWNER_ONLY_PERMISSIONS = [
    'org.delete',
    'org.transfer',
] as const;

/** Quick lookup set for validation. */
export const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

// ── Default role permission sets ────────────────────────────────────

/** Admin gets everything in the vocabulary. */
export const ADMIN_PERMISSIONS: readonly Permission[] = [...ALL_PERMISSIONS];

/** Operator: day-to-day execution, realm config, no org-level admin. */
export const OPERATOR_PERMISSIONS: readonly Permission[] = [
    'realms.view',
    'realms.teams.manage',
    'daemons.enroll',
    'daemons.view',
    'teams.run',
    'teams.cancel',
    'teams.inputs',
    'teams.install',
    'teams.publish',
    'teams.catalog.view',
    'runs.view',
    'channels.manage.realm',
    'rules.manage.realm',
    'inbox.view',
    'agents.manage.realm',
    'agents.view',
    'reviews.verdict',
    'reviews.view',
];

/** Member: read-only observer. */
export const MEMBER_PERMISSIONS: readonly Permission[] = [
    'realms.view',
    'daemons.view',
    'runs.view',
    'teams.catalog.view',
    'inbox.view',
    'reviews.view',
    'agents.view',
];

/**
 * Default role definitions seeded on org creation.
 * Owner role has is_system=true and gets all permissions implicitly
 * (its permissions array is empty by convention).
 */
export const DEFAULT_ROLES = [
    { slug: 'owner', name: 'Owner', permissions: [] as string[], is_system: true, is_default: true },
    { slug: 'admin', name: 'Admin', permissions: [...ADMIN_PERMISSIONS], is_system: false, is_default: true },
    { slug: 'operator', name: 'Operator', permissions: [...OPERATOR_PERMISSIONS], is_system: false, is_default: true },
    { slug: 'member', name: 'Member', permissions: [...MEMBER_PERMISSIONS], is_system: false, is_default: true },
] as const;

// ── Permission enforcement ──────────────────────────────────────────

import { OrgMember, OrgRole } from '../db/models/index.js';
import { ApiError } from '../errors/api_error.js';

/**
 * Check whether a user has a specific permission within an org.
 * Throws 403 if denied, returns silently if allowed.
 *
 * Resolution order:
 *   1. Site admin → allow everything (bypass).
 *   2. Load org_members row → get role_id.
 *   3. Load org_roles row → if is_system (owner) → allow everything.
 *   4. Check permission ∈ role.permissions.
 */
export async function require_permission(
    org_id: string,
    user_id: string,
    permission: string,
    opts?: { site_role?: string },
): Promise<void> {
    if (opts?.site_role === 'admin') return;

    const member = await OrgMember.findOne({
        where: { org_id, user_id },
        attributes: ['role_id'],
        raw: true,
    });
    if (!member) {
        throw new ApiError('forbidden', 'You are not a member of this organization', 403);
    }
    if (!member.role_id) {
        throw new ApiError('forbidden', 'No role assigned — contact your org admin', 403);
    }

    const role = await OrgRole.findByPk(member.role_id, {
        attributes: ['is_system', 'permissions'],
        raw: true,
    });
    if (!role) {
        throw new ApiError('forbidden', 'Role not found — contact your org admin', 403);
    }

    // Owner (system role) has all permissions implicitly.
    if (role.is_system) return;

    const perms: string[] = role.permissions ?? [];
    if (!perms.includes(permission)) {
        throw new ApiError('forbidden', `Permission '${permission}' is required`, 403);
    }
}

/**
 * Express middleware helper: extract org + user ids from the request
 * and check a permission. Works with both Hub-layer and Core-API shapes.
 */
export async function require_permission_from_req(
    req: { auth?: { user?: { id: string; role?: string } | null; current_org_id?: string }; user?: { user_id?: string; role?: string; current_org_id?: string } },
    permission: string,
): Promise<void> {
    const hub_user = req.auth?.user;
    const core_user = req.user;

    const user_id = hub_user?.id ?? core_user?.user_id;
    if (!user_id) {
        throw new ApiError('unauthorized', 'Authentication required', 401);
    }

    const org_id = req.auth?.current_org_id ?? core_user?.current_org_id;
    if (!org_id) {
        throw new ApiError('forbidden', 'No active organization context', 403);
    }

    const site_role = hub_user?.role ?? core_user?.role;
    await require_permission(String(org_id), String(user_id), permission, { site_role });
}
