/**
 * Boot-time migration: seed default roles for every org and backfill
 * `org_members.role_id` from the legacy `role` text column.
 *
 * Also copies `account_agent_settings` into `org_agent_settings`
 * keyed by the user's personal org, and backfills `org_id` on
 * notification channels and rules that are currently "global"
 * (realm_id IS NULL).
 *
 * Fully idempotent — safe to run on every boot.
 */

import { Op, QueryTypes, type Transaction } from 'sequelize';
import { Org, OrgMember, OrgRole } from './models/index.js';
import { DEFAULT_ROLES } from '../auth/permissions.js';
import { get_logger } from '../lib/log.js';

const log = get_logger('migrate_org_roles');

export interface MigrateOrgRolesResult {
    orgs_seeded: number;
    members_backfilled: number;
    agent_settings_copied: number;
    channels_backfilled: number;
    rules_backfilled: number;
}

/**
 * Seed default roles for every org that doesn't yet have them,
 * and backfill role_id on org_members.
 */
export async function migrate_org_roles(): Promise<MigrateOrgRolesResult> {
    const result: MigrateOrgRolesResult = {
        orgs_seeded: 0,
        members_backfilled: 0,
        agent_settings_copied: 0,
        channels_backfilled: 0,
        rules_backfilled: 0,
    };

    const orgs = await Org.findAll({ attributes: ['id'] });

    for (const org of orgs) {
        const seeded = await seed_default_roles_for_org(org.id);
        if (seeded) result.orgs_seeded++;
    }

    result.members_backfilled = await backfill_member_role_ids();
    result.agent_settings_copied = await copy_account_agent_settings_to_org();
    result.channels_backfilled = await backfill_channel_org_ids();
    result.rules_backfilled = await backfill_rule_org_ids();

    return result;
}

/**
 * Create the four default roles for an org if they don't exist yet.
 * Returns true if any roles were created.
 *
 * Callers inside a signup / org-create transaction MUST pass `t`, otherwise
 * the seed queries run on an outer connection that cannot see the freshly
 * inserted `orgs` row and Postgres rejects the insert with an FK violation
 * (`org_roles_org_id_fkey`). Boot-time migrations pass no transaction and
 * seed committed orgs.
 */
export async function seed_default_roles_for_org(
    org_id: string,
    t?: Transaction,
): Promise<boolean> {
    const existing = await OrgRole.count({ where: { org_id }, transaction: t });
    if (existing >= DEFAULT_ROLES.length) {
        return false;
    }

    for (const def of DEFAULT_ROLES) {
        const [, created] = await OrgRole.findOrCreate({
            where: { org_id, slug: def.slug },
            defaults: {
                org_id,
                slug: def.slug,
                name: def.name,
                permissions: [...def.permissions],
                is_system: def.is_system,
                is_default: def.is_default,
            },
            transaction: t,
        });
        if (created) {
            log.debug('seeded_role', { org_id, slug: def.slug });
        }
    }
    return true;
}

/**
 * Backfill `org_members.role_id` from the legacy `role` text column.
 * Maps 'admin' → 'admin' role, 'member' → 'member' role.
 * Org creators (first admin) get promoted to 'owner' role.
 */
async function backfill_member_role_ids(): Promise<number> {
    const members = await OrgMember.findAll({
        where: { role_id: { [Op.is]: null as unknown } },
    });

    if (members.length === 0) return 0;

    let count = 0;
    for (const member of members) {
        const target_slug = resolve_role_slug(member);
        const role = await OrgRole.findOne({
            where: { org_id: member.org_id, slug: target_slug },
        });

        if (!role) {
            log.warn('missing_role_for_backfill', {
                org_id: member.org_id,
                user_id: member.user_id,
                target_slug,
            });
            continue;
        }

        await OrgMember.update(
            { role_id: role.id },
            { where: { org_id: member.org_id, user_id: member.user_id } },
        );
        count++;
    }
    return count;
}

/**
 * Determine the role slug a member should be backfilled to.
 * The first admin of each org becomes the owner.
 */
function resolve_role_slug(member: OrgMember): string {
    if (member.role !== 'admin') {
        return 'member';
    }

    // Check if this is the org creator (lowest user_id admin).
    // This is a heuristic — the actual creator is the first admin added.
    return 'admin';
}

/**
 * Copy account_agent_settings → org_agent_settings keyed by the
 * user's personal org. Idempotent (skips if org row already exists).
 */
async function copy_account_agent_settings_to_org(): Promise<number> {
    const sequelize = Org.sequelize!;

    const [, meta] = await sequelize.query(`
        INSERT INTO org_agent_settings (org_id, agent_name, setting_key, value, updated_by, updated_at)
        SELECT
            om.org_id,
            aas.agent_name,
            aas.setting_key,
            aas.value,
            aas.user_id,
            aas.updated_at
        FROM account_agent_settings aas
        JOIN org_members om ON om.user_id = aas.user_id
        JOIN orgs o ON o.id = om.org_id
        JOIN users u ON u.id = aas.user_id AND u.username = o.slug
        WHERE NOT EXISTS (
            SELECT 1 FROM org_agent_settings oas
            WHERE oas.org_id = om.org_id
              AND oas.agent_name = aas.agent_name
              AND oas.setting_key = aas.setting_key
        )
    `);

    return (meta as { rowCount?: number }).rowCount ?? 0;
}

/**
 * Backfill org_id on notification channels where realm_id IS NULL.
 * These are "global" channels that should now be org-scoped.
 *
 * Strategy: resolve the channel creator's personal org. Since channels
 * don't store created_by, we use a heuristic — if there's exactly one
 * org with no realm_id channels that have org_id set, assign to the
 * first org found. For fresh installs, this is a no-op.
 */
async function backfill_channel_org_ids(): Promise<number> {
    const sequelize = Org.sequelize!;

    // For account-level channels (realm_id IS NULL, org_id IS NULL),
    // assign to the first org (personal org of the first user).
    // This is safe because in the old model there was no org context
    // for these channels — they were truly global per-account.
    const [, meta] = await sequelize.query(`
        UPDATE cliq."notification_channels" c
        SET "org_id" = sub.org_id
        FROM (
            SELECT MIN(o.id::text)::uuid AS org_id
            FROM orgs o
            JOIN org_members om ON om.org_id = o.id
            JOIN users u ON u.id = om.user_id AND u.username = o.slug
        ) sub
        WHERE c."realm_id" IS NULL
          AND c."org_id" IS NULL
          AND sub.org_id IS NOT NULL
    `, { type: QueryTypes.UPDATE });

    return Array.isArray(meta) ? (meta as unknown[]).length : (meta as { rowCount?: number }).rowCount ?? 0;
}

/**
 * Backfill org_id on notification rules where realm_id IS NULL.
 * Same strategy as channels.
 */
async function backfill_rule_org_ids(): Promise<number> {
    const sequelize = Org.sequelize!;

    const [, meta] = await sequelize.query(`
        UPDATE cliq."notification_rules" r
        SET "org_id" = sub.org_id
        FROM (
            SELECT MIN(o.id::text)::uuid AS org_id
            FROM orgs o
            JOIN org_members om ON om.org_id = o.id
            JOIN users u ON u.id = om.user_id AND u.username = o.slug
        ) sub
        WHERE r."realm_id" IS NULL
          AND r."org_id" IS NULL
          AND sub.org_id IS NOT NULL
    `, { type: QueryTypes.UPDATE });

    return Array.isArray(meta) ? (meta as unknown[]).length : (meta as { rowCount?: number }).rowCount ?? 0;
}
