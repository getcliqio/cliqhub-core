/**
 * Remint Hub entity UUIDs that were deterministically derived from legacy
 * integers (`00000000-0000-4000-8000-…`) to fresh `gen_random_uuid()` values,
 * cascading through all known FK / text-id columns.
 *
 * Idempotent: no-ops when no legacy-pattern ids remain.
 */

import { QueryTypes, type Sequelize } from 'sequelize';

const LEGACY_PREFIX = '00000000-0000-4000-8000-';

function quote_ident(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

async function column_exists(
    sequelize: Sequelize,
    schema: string,
    table: string,
    column: string,
): Promise<boolean> {
    const rows = await sequelize.query<{ exists: boolean }>(
        `SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = :schema AND table_name = :table AND column_name = :column
         ) AS exists`,
        { replacements: { schema, table, column }, type: QueryTypes.SELECT },
    );
    return Boolean(rows[0]?.exists);
}

async function count_legacy_pk(sequelize: Sequelize, table: string): Promise<number> {
    if (!(await column_exists(sequelize, 'public', table, 'id'))) return 0;
    const rows = await sequelize.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM public.${quote_ident(table)}
         WHERE id::text LIKE :pat`,
        { replacements: { pat: `${LEGACY_PREFIX}%` }, type: QueryTypes.SELECT },
    );
    return Number(rows[0]?.n ?? 0);
}

async function drop_all_fks_on_public(sequelize: Sequelize): Promise<void> {
    const fks = await sequelize.query<{ table_name: string; constraint_name: string }>(
        `SELECT tc.table_name, tc.constraint_name
         FROM information_schema.table_constraints tc
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema = 'public'`,
        { type: QueryTypes.SELECT },
    );
    for (const fk of fks) {
        await sequelize.query(
            `ALTER TABLE public.${quote_ident(fk.table_name)}
             DROP CONSTRAINT IF EXISTS ${quote_ident(fk.constraint_name)}`,
        );
    }
}

type Fk_ref = {
    schema: string;
    table: string;
    column: string;
    /** When true, compare/update as text (session ids, denormalized text FKs). */
    as_text?: boolean;
};

/** Root entity tables whose `id` PKs may still be hub_legacy_uuid(n). */
const ROOT_TABLES = [
    'users',
    'orgs',
    'scopes',
    'org_roles',
    'teams',
    'team_versions',
    'drafts',
    'audit_log',
    'account_invites',
    'realm_invites',
] as const;

/** Child columns that store a reminted entity id. */
const REFS: Record<(typeof ROOT_TABLES)[number], Fk_ref[]> = {
    users: [
        { schema: 'public', table: 'org_members', column: 'user_id' },
        { schema: 'public', table: 'scope_members', column: 'user_id' },
        { schema: 'public', table: 'scopes', column: 'owner_id' },
        { schema: 'public', table: 'teams', column: 'author_id' },
        { schema: 'public', table: 'tokens', column: 'user_id' },
        { schema: 'public', table: 'drafts', column: 'user_id' },
        { schema: 'public', table: 'audit_log', column: 'admin_id' },
        { schema: 'public', table: 'account_invites', column: 'invited_by' },
        { schema: 'public', table: 'account_invites', column: 'accepted_user_id' },
        { schema: 'public', table: 'realm_invites', column: 'invited_by' },
        { schema: 'public', table: 'realm_invites', column: 'accepted_user_id' },
        { schema: 'public', table: 'org_agent_settings', column: 'updated_by' },
        { schema: 'public', table: 'account_agent_settings', column: 'user_id' },
        { schema: 'public', table: 'realm_agent_settings', column: 'user_id' },
        { schema: 'bff', table: 'sessions', column: 'user_id', as_text: true },
        { schema: 'bff', table: 'sessions', column: 'act_as_user_id', as_text: true },
        { schema: 'cliq', table: 'daemons', column: 'user_id', as_text: true },
        { schema: 'cliq', table: 'account_mesh_settings', column: 'user_id', as_text: true },
        { schema: 'cliq', table: 'realms', column: 'owner_user_id', as_text: true },
        { schema: 'cliq', table: 'realms', column: 'created_by', as_text: true },
        { schema: 'cliq', table: 'realm_members', column: 'member_id', as_text: true },
        { schema: 'cliq', table: 'in_app_notifications', column: 'user_id' },
        { schema: 'cliq', table: 'notification_channels', column: 'user_id' },
        { schema: 'cliq', table: 'review_notifications', column: 'user_id' },
    ],
    orgs: [
        { schema: 'public', table: 'org_members', column: 'org_id' },
        { schema: 'public', table: 'org_roles', column: 'org_id' },
        { schema: 'public', table: 'scopes', column: 'org_id' },
        { schema: 'public', table: 'account_invites', column: 'org_id' },
        { schema: 'public', table: 'org_agent_settings', column: 'org_id' },
        { schema: 'cliq', table: 'realms', column: 'org_id' },
        { schema: 'cliq', table: 'reviews', column: 'org_id' },
        { schema: 'cliq', table: 'in_app_notifications', column: 'org_id' },
        { schema: 'cliq', table: 'team_runs', column: 'org_id' },
        { schema: 'cliq', table: 'notification_channels', column: 'org_id' },
        { schema: 'cliq', table: 'notification_rules', column: 'org_id' },
        { schema: 'cliq', table: 'org_dispatch_keys', column: 'org_id', as_text: true },
        { schema: 'cliq', table: 'events', column: 'org_id', as_text: true },
        { schema: 'cliq', table: 'scopes', column: 'org_id', as_text: true },
    ],
    scopes: [
        { schema: 'public', table: 'scope_members', column: 'scope_id' },
        { schema: 'public', table: 'orgs', column: 'default_scope_id' },
        { schema: 'cliq', table: 'teams', column: 'scope_id', as_text: true },
        { schema: 'cliq', table: 'workspaces', column: 'scope_id', as_text: true },
    ],
    org_roles: [
        { schema: 'public', table: 'org_members', column: 'role_id' },
    ],
    teams: [
        { schema: 'public', table: 'team_versions', column: 'team_id' },
        { schema: 'public', table: 'team_tags', column: 'team_id' },
        { schema: 'public', table: 'download_log', column: 'team_id' },
        { schema: 'cliq', table: 'team_runs', column: 'team_id', as_text: true },
        { schema: 'cliq', table: 'workspace_teams', column: 'team_id', as_text: true },
        { schema: 'cliq', table: 'workspaces', column: 'team_id', as_text: true },
    ],
    team_versions: [],
    drafts: [],
    audit_log: [],
    account_invites: [],
    realm_invites: [],
};

async function normalize_numeric_text_org_ids(sequelize: Sequelize): Promise<void> {
    // Leftover int-as-text org_ids (e.g. '1') → legacy UUID text so remint can map them.
    if (!(await column_exists(sequelize, 'cliq', 'org_dispatch_keys', 'org_id'))) return;
    await sequelize.query(`
        UPDATE cliq.org_dispatch_keys
        SET org_id = '00000000-0000-4000-8000-' || lpad(to_hex(org_id::bigint), 12, '0')
        WHERE org_id ~ '^[0-9]+$'
    `);
}

/** Bare int user ids stored as TEXT → hub_legacy_uuid so user remint cascades. */
async function normalize_numeric_text_user_ids(sequelize: Sequelize): Promise<void> {
    const refs: Array<{ schema: string; table: string; column: string }> = [
        { schema: 'cliq', table: 'realms', column: 'owner_user_id' },
        { schema: 'cliq', table: 'realms', column: 'created_by' },
        { schema: 'cliq', table: 'realm_members', column: 'member_id' },
        { schema: 'cliq', table: 'daemons', column: 'user_id' },
        { schema: 'cliq', table: 'account_mesh_settings', column: 'user_id' },
    ];
    for (const ref of refs) {
        if (!(await column_exists(sequelize, ref.schema, ref.table, ref.column))) continue;
        await sequelize.query(`
            UPDATE ${quote_ident(ref.schema)}.${quote_ident(ref.table)}
            SET ${quote_ident(ref.column)} =
                '00000000-0000-4000-8000-' || lpad(to_hex((${quote_ident(ref.column)})::bigint), 12, '0')
            WHERE ${quote_ident(ref.column)} ~ '^[0-9]+$'
        `);
    }
}

async function remint_root(sequelize: Sequelize, table: (typeof ROOT_TABLES)[number]): Promise<number> {
    const legacy_n = await count_legacy_pk(sequelize, table);
    if (legacy_n === 0) return 0;

    // Persistent staging table (not TEMP) — Sequelize pool uses multiple connections.
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS public._hub_uuid_remint_map (
            old_id UUID PRIMARY KEY,
            new_id UUID NOT NULL UNIQUE
        )
    `);
    await sequelize.query(`TRUNCATE public._hub_uuid_remint_map`);

    await sequelize.query(`
        INSERT INTO public._hub_uuid_remint_map (old_id, new_id)
        SELECT id, gen_random_uuid()
        FROM public.${quote_ident(table)}
        WHERE id::text LIKE :pat
    `, { replacements: { pat: `${LEGACY_PREFIX}%` } });

    for (const ref of REFS[table]) {
        if (!(await column_exists(sequelize, ref.schema, ref.table, ref.column))) continue;
        if (ref.as_text) {
            await sequelize.query(`
                UPDATE ${quote_ident(ref.schema)}.${quote_ident(ref.table)} AS t
                SET ${quote_ident(ref.column)} = m.new_id::text
                FROM public._hub_uuid_remint_map AS m
                WHERE t.${quote_ident(ref.column)} = m.old_id::text
            `);
        } else {
            await sequelize.query(`
                UPDATE ${quote_ident(ref.schema)}.${quote_ident(ref.table)} AS t
                SET ${quote_ident(ref.column)} = m.new_id
                FROM public._hub_uuid_remint_map AS m
                WHERE t.${quote_ident(ref.column)} = m.old_id
            `);
        }
    }

    await sequelize.query(`
        UPDATE public.${quote_ident(table)} AS t
        SET id = m.new_id
        FROM public._hub_uuid_remint_map AS m
        WHERE t.id = m.old_id
    `);

    await sequelize.query(`TRUNCATE public._hub_uuid_remint_map`);
    return legacy_n;
}

async function recreate_public_fks(sequelize: Sequelize): Promise<void> {
    const fks: Array<[string, string, string, string, string]> = [
        ['org_members', 'org_id', 'orgs', 'id', 'CASCADE'],
        ['org_members', 'user_id', 'users', 'id', 'CASCADE'],
        ['org_members', 'role_id', 'org_roles', 'id', 'SET NULL'],
        ['scopes', 'owner_id', 'users', 'id', 'NO ACTION'],
        ['scopes', 'org_id', 'orgs', 'id', 'SET NULL'],
        ['orgs', 'default_scope_id', 'scopes', 'id', 'SET NULL'],
        ['scope_members', 'scope_id', 'scopes', 'id', 'CASCADE'],
        ['scope_members', 'user_id', 'users', 'id', 'CASCADE'],
        ['teams', 'author_id', 'users', 'id', 'SET NULL'],
        ['team_versions', 'team_id', 'teams', 'id', 'CASCADE'],
        ['team_tags', 'team_id', 'teams', 'id', 'CASCADE'],
        ['download_log', 'team_id', 'teams', 'id', 'CASCADE'],
        ['tokens', 'user_id', 'users', 'id', 'CASCADE'],
        ['drafts', 'user_id', 'users', 'id', 'CASCADE'],
        ['audit_log', 'admin_id', 'users', 'id', 'NO ACTION'],
        ['org_roles', 'org_id', 'orgs', 'id', 'CASCADE'],
        ['account_invites', 'org_id', 'orgs', 'id', 'CASCADE'],
        ['account_invites', 'invited_by', 'users', 'id', 'NO ACTION'],
        ['account_invites', 'accepted_user_id', 'users', 'id', 'NO ACTION'],
        ['realm_invites', 'invited_by', 'users', 'id', 'NO ACTION'],
        ['realm_invites', 'accepted_user_id', 'users', 'id', 'NO ACTION'],
        ['org_agent_settings', 'org_id', 'orgs', 'id', 'CASCADE'],
        ['org_agent_settings', 'updated_by', 'users', 'id', 'NO ACTION'],
        ['account_agent_settings', 'user_id', 'users', 'id', 'CASCADE'],
        ['realm_agent_settings', 'user_id', 'users', 'id', 'CASCADE'],
    ];

    for (const [child, col, parent, pcol, on_delete] of fks) {
        if (!(await column_exists(sequelize, 'public', child, col))) continue;
        if (!(await column_exists(sequelize, 'public', parent, pcol))) continue;
        const cname = `${child}_${col}_fkey`;
        await sequelize.query(`
            ALTER TABLE public.${quote_ident(child)}
            DROP CONSTRAINT IF EXISTS ${quote_ident(cname)}
        `);
        await sequelize.query(`
            ALTER TABLE public.${quote_ident(child)}
            ADD CONSTRAINT ${quote_ident(cname)}
            FOREIGN KEY (${quote_ident(col)})
            REFERENCES public.${quote_ident(parent)}(${quote_ident(pcol)})
            ON DELETE ${on_delete}
        `);
    }
}

/**
 * Remint deterministic legacy Hub UUIDs to random UUIDs.
 * Safe to re-run: no-ops when none remain.
 * Skipped under Vitest — fixtures still use stable ids (incl. legacy-shaped).
 */
export async function migrate_hub_remint_legacy_uuids(sequelize: Sequelize): Promise<void> {
    if (process.env.VITEST || process.env.CLIQHUB_SKIP_UUID_REMINT === '1') {
        return;
    }
    await sequelize.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    let total = 0;
    for (const table of ROOT_TABLES) {
        total += await count_legacy_pk(sequelize, table);
    }
    if (total === 0) return;

    await normalize_numeric_text_org_ids(sequelize);
    await normalize_numeric_text_user_ids(sequelize);
    await drop_all_fks_on_public(sequelize);

    // Parents before children that also have reminted PKs (orgs before org_roles, etc.).
    // FK updates use temp maps, so order among roots only matters for self-FKs
    // (orgs.default_scope_id ↔ scopes): remint scopes before updating orgs.default_scope_id
    // via scopes refs — scopes list includes orgs.default_scope_id.
    // Remint users → orgs → scopes → rest.
    const order: Array<(typeof ROOT_TABLES)[number]> = [
        'users',
        'orgs',
        'scopes',
        'org_roles',
        'teams',
        'team_versions',
        'drafts',
        'audit_log',
        'account_invites',
        'realm_invites',
    ];

    for (const table of order) {
        await remint_root(sequelize, table);
    }

    await recreate_public_fks(sequelize);
    await sequelize.query(`DROP TABLE IF EXISTS public._hub_uuid_remint_map`);
}
