/**
 * Boot-time repair of the shared name space (orgs / scopes / usernames) after
 * partial org creates and user deletes left rows behind.
 *
 * Before org create ran in one transaction, a failure part-way could leave a
 * user, their scope and an org without its scope. And deleting a user or org
 * only SET NULLs `scopes.owner_id` / `scopes.org_id`, so their scopes kept
 * holding the name ("A scope with that slug already exists").
 *
 * This repair, all in one transaction and idempotent:
 *   1. deletes orphaned scopes that hold a name for nobody:
 *        - `user` scopes whose user no longer exists (and that belong to no org),
 *        - `org` scopes whose org no longer exists;
 *      never one that still has teams (those are reported in `skipped`), never a
 *      reserved or default scope, and never a `platform` scope;
 *   2. gives every non-personal org that has no scope its scope back
 *      (slug = org slug, owned by an org owner/admin), when that name is free.
 *      Personal orgs (a user has the same name) are left as they are: users
 *      created by an admin legitimately have a user scope and a personal org
 *      without an org scope.
 *
 * Nothing else is touched. The result lists every slug changed or skipped.
 */

import { QueryTypes, type Sequelize } from 'sequelize';
import { RESERVED_SLUGS } from '../../config/env.js';
import { get_logger } from '../../lib/log.js';

const log = get_logger('migrate_namespace_orphans');

/** What the repair did (slugs), and what it left alone and why. */
export interface RepairNamespaceResult {
    user_scopes_removed: string[];
    org_scopes_removed: string[];
    org_scopes_created: string[];
    skipped: Array<{ slug: string; reason: string }>;
}

/** Runs the repair described in the module header. Safe to run on every boot. */
export async function repair_namespace_orphans(sequelize: Sequelize): Promise<RepairNamespaceResult> {
    const result: RepairNamespaceResult = { user_scopes_removed: [], org_scopes_removed: [], org_scopes_created: [], skipped: [] };
    const reserved = [...RESERVED_SLUGS];

    await sequelize.transaction(async (transaction) => {
        // 1. Orphaned scopes.
        const orphans = await sequelize.query<{ id: string; slug: string; scope_type: string; teams: number }>(`
            SELECT s.id, s.slug, s.scope_type,
                   (SELECT count(*)::int FROM cliq.teams t WHERE t.scope = s.slug) AS teams
              FROM cliq.scopes s
             WHERE s.is_default = 0
               AND s.slug NOT IN (:reserved)
               AND (
                    (s.scope_type = 'user' AND s.org_id IS NULL
                        AND (s.owner_id IS NULL OR NOT EXISTS (SELECT 1 FROM cliq.users u WHERE u.id = s.owner_id)))
                 OR (s.scope_type = 'org'
                        AND (s.org_id IS NULL OR NOT EXISTS (SELECT 1 FROM cliq.orgs o WHERE o.id = s.org_id)))
               )
             ORDER BY s.slug`,
            { replacements: { reserved }, type: QueryTypes.SELECT, transaction },
        );
        const removable = orphans.filter((s) => {
            if (s.teams > 0) result.skipped.push({ slug: s.slug, reason: `orphaned ${s.scope_type} scope still has ${s.teams} team(s)` });
            return s.teams === 0;
        });
        if (removable.length) {
            const ids = removable.map((s) => s.id);
            await sequelize.query('DELETE FROM cliq.scope_members WHERE scope_id IN (:ids)', { replacements: { ids }, transaction });
            await sequelize.query('DELETE FROM cliq.scopes WHERE id IN (:ids)', { replacements: { ids }, transaction });
            for (const s of removable) (s.scope_type === 'user' ? result.user_scopes_removed : result.org_scopes_removed).push(s.slug);
        }

        // 2. Non-personal orgs without any scope.
        const bare = await sequelize.query<{ id: string; slug: string; display_name: string; default_scope_id: string | null; owner_id: string | null; taken: boolean }>(`
            SELECT o.id, o.slug, o.display_name, o.default_scope_id,
                   (SELECT m.user_id FROM cliq.org_members m
                      LEFT JOIN cliq.org_roles r ON r.id = m.role_id
                     WHERE m.org_id = o.id
                     ORDER BY CASE WHEN r.slug = 'owner' THEN 0 WHEN m.role IN ('owner', 'admin') OR r.slug = 'admin' THEN 1 ELSE 2 END, m.user_id
                     LIMIT 1) AS owner_id,
                   EXISTS (SELECT 1 FROM cliq.scopes s2 WHERE s2.slug = o.slug) AS taken
              FROM cliq.orgs o
             WHERE NOT EXISTS (SELECT 1 FROM cliq.scopes s WHERE s.org_id = o.id)
               AND NOT EXISTS (SELECT 1 FROM cliq.users u WHERE u.username = o.slug)
             ORDER BY o.slug`,
            { type: QueryTypes.SELECT, transaction },
        );
        for (const org of bare) {
            if (org.taken) { result.skipped.push({ slug: org.slug, reason: 'org has no scope and its name is held by another scope' }); continue; }
            if (!org.owner_id) { result.skipped.push({ slug: org.slug, reason: 'org has no scope and no members to own one' }); continue; }
            const [rows] = await sequelize.query(`
                INSERT INTO cliq.scopes (id, slug, display_name, owner_id, org_id, visibility, scope_type, created_at, is_default)
                VALUES (gen_random_uuid(), :slug, :display_name, :owner_id, :org_id, 'public', 'org', NOW(), 0)
                RETURNING id`,
                { replacements: { slug: org.slug, display_name: org.display_name || org.slug, owner_id: org.owner_id, org_id: org.id }, transaction },
            ) as [Array<{ id: string }>, unknown];
            const scope_id = rows[0].id;
            await sequelize.query(`
                INSERT INTO cliq.scope_members (scope_id, user_id)
                SELECT :scope_id, m.user_id FROM cliq.org_members m
                  LEFT JOIN cliq.org_roles r ON r.id = m.role_id
                 WHERE m.org_id = :org_id AND (r.slug IN ('owner', 'admin') OR m.role IN ('owner', 'admin') OR m.user_id = :owner_id)
                ON CONFLICT DO NOTHING`,
                { replacements: { scope_id, org_id: org.id, owner_id: org.owner_id }, transaction },
            );
            if (!org.default_scope_id) {
                await sequelize.query('UPDATE cliq.orgs SET default_scope_id = :scope_id WHERE id = :org_id', { replacements: { scope_id, org_id: org.id }, transaction });
            }
            result.org_scopes_created.push(org.slug);
        }
    });

    if (result.user_scopes_removed.length || result.org_scopes_removed.length || result.org_scopes_created.length || result.skipped.length) {
        log.info('namespace_repaired', { ...result });
    }
    return result;
}
