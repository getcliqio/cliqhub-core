/**
 * Repair cliq.realms / realm_members / daemons user refs left as bare integer
 * strings after Hub UUID PK + remint (TEXT columns never cascaded).
 *
 * Map: personal-org default realm (org.slug = username, slug = 'default')
 * owns the old integer → current users.id.
 *
 * Idempotent: no-ops when no numeric / orphan owner refs remain.
 */

import { QueryTypes, type Sequelize } from 'sequelize';

export async function migrate_repair_realm_user_refs(sequelize: Sequelize): Promise<void> {
    const orphans = await sequelize.query<{ n: string }>(
        `SELECT (
            (SELECT COUNT(*) FROM cliq.realms r
             WHERE NOT r.deleted
               AND (r.owner_user_id ~ '^[0-9]+$'
                    OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id::text = r.owner_user_id)))
          + (SELECT COUNT(*) FROM cliq.realm_members rm
             WHERE rm.member_type = 'user'
               AND (rm.member_id ~ '^[0-9]+$'
                    OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id::text = rm.member_id)))
          + (SELECT COUNT(*) FROM cliq.daemons d
             WHERE d.user_id ~ '^[0-9]+$'
                OR (d.user_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id::text = d.user_id)))
         )::text AS n`,
        { type: QueryTypes.SELECT },
    );
    if (Number(orphans[0]?.n ?? 0) === 0) return;

    // Persistent staging — Sequelize pool may use multiple connections.
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS public._hub_realm_user_repair_map (
            old_id TEXT PRIMARY KEY,
            new_id TEXT NOT NULL
        )
    `);
    await sequelize.query(`TRUNCATE public._hub_realm_user_repair_map`);

    await sequelize.query(`
        INSERT INTO public._hub_realm_user_repair_map (old_id, new_id)
        SELECT DISTINCT ON (r.owner_user_id) r.owner_user_id, u.id::text
        FROM cliq.realms r
        JOIN public.orgs o ON o.id = r.org_id
        JOIN public.users u ON lower(u.username) = o.slug
        WHERE NOT r.deleted
          AND r.slug = 'default'
          AND r.owner_user_id ~ '^[0-9]+$'
        ORDER BY r.owner_user_id, u.id
        ON CONFLICT (old_id) DO NOTHING
    `);

    await sequelize.query(`
        INSERT INTO public._hub_realm_user_repair_map (old_id, new_id)
        SELECT DISTINCT ON (r.owner_user_id) r.owner_user_id, u.id::text
        FROM cliq.realms r
        JOIN public.orgs o ON o.id = r.org_id
        JOIN public.users u ON lower(u.username) = o.slug
        WHERE NOT r.deleted
          AND r.owner_user_id ~ '^[0-9]+$'
          AND NOT EXISTS (
            SELECT 1 FROM public._hub_realm_user_repair_map m WHERE m.old_id = r.owner_user_id
          )
        ORDER BY r.owner_user_id, u.id
        ON CONFLICT (old_id) DO NOTHING
    `);

    await sequelize.query(`
        UPDATE cliq.realms r
        SET owner_user_id = m.new_id
        FROM public._hub_realm_user_repair_map m
        WHERE r.owner_user_id = m.old_id
    `);
    await sequelize.query(`
        UPDATE cliq.realms r
        SET created_by = m.new_id
        FROM public._hub_realm_user_repair_map m
        WHERE r.created_by = m.old_id
    `);
    await sequelize.query(`
        UPDATE cliq.realm_members rm
        SET member_id = m.new_id
        FROM public._hub_realm_user_repair_map m
        WHERE rm.member_type = 'user' AND rm.member_id = m.old_id
    `);
    await sequelize.query(`
        UPDATE cliq.daemons d
        SET user_id = m.new_id
        FROM public._hub_realm_user_repair_map m
        WHERE d.user_id = m.old_id
    `);

    // Daemons that still have bare ints: match user_email → users.email.
    await sequelize.query(`
        UPDATE cliq.daemons d
        SET user_id = u.id::text
        FROM public.users u
        WHERE d.user_id ~ '^[0-9]+$'
          AND d.user_email IS NOT NULL
          AND lower(u.email) = lower(d.user_email)
    `);

    // Personal default: reclaim ownership if still drifted.
    await sequelize.query(`
        UPDATE cliq.realms r
        SET owner_user_id = u.id::text,
            created_by = CASE
                WHEN r.created_by ~ '^[0-9]+$'
                  OR NOT EXISTS (SELECT 1 FROM public.users x WHERE x.id::text = r.created_by)
                THEN u.id::text
                ELSE r.created_by
            END
        FROM public.orgs o
        JOIN public.users u ON lower(u.username) = o.slug
        WHERE r.org_id = o.id
          AND NOT r.deleted
          AND r.slug = 'default'
          AND r.owner_user_id <> u.id::text
    `);

    await sequelize.query(`
        UPDATE public.users u
        SET default_realm_id = r.id
        FROM public.orgs o
        JOIN cliq.realms r ON r.org_id = o.id AND r.slug = 'default' AND NOT r.deleted
        WHERE o.slug = lower(u.username)
          AND r.owner_user_id = u.id::text
          AND (u.default_realm_id IS NULL OR u.default_realm_id <> r.id)
    `);

    await sequelize.query(`DROP TABLE IF EXISTS public._hub_realm_user_repair_map`);
}
