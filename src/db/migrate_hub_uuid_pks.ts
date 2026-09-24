/**
 * Convert Hub public-schema integer PKs/FKs to UUID (idempotent).
 * Deterministic mapping: hub_legacy_uuid(n) = 00000000-0000-4000-8000- + 12 hex digits.
 *
 * See design/SLICE-uuid-primary-keys.md
 */

import { QueryTypes, type Sequelize } from 'sequelize';

async function users_id_is_uuid(sequelize: Sequelize): Promise<boolean> {
    const rows = await sequelize.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id'`,
        { type: QueryTypes.SELECT },
    );
    if (rows.length === 0) return true; // no users table yet — sequelize.sync will create UUID
    return rows[0].data_type === 'uuid';
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
            `ALTER TABLE public.${quote_ident(fk.table_name)} DROP CONSTRAINT IF EXISTS ${quote_ident(fk.constraint_name)}`,
        );
    }
}

function quote_ident(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/** SQL expression: int/bigint → deterministic UUID text then cast. */
const LEGACY = (col: string) =>
    `('00000000-0000-4000-8000-' || lpad(to_hex((${col})::bigint), 12, '0'))::uuid`;

async function column_data_type(
    sequelize: Sequelize,
    table: string,
    column: string,
): Promise<string | null> {
    const rows = await sequelize.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = :table AND column_name = :column`,
        { replacements: { table, column }, type: QueryTypes.SELECT },
    );
    return rows[0]?.data_type ?? null;
}

async function alter_int_to_uuid(
    sequelize: Sequelize,
    table: string,
    column: string,
    opts: { drop_default?: boolean; set_uuid_default?: boolean } = {},
): Promise<void> {
    const dt = await column_data_type(sequelize, table, column);
    if (!dt) return;
    if (dt === 'uuid') {
        if (opts.set_uuid_default) {
            await sequelize.query(
                `ALTER TABLE public.${quote_ident(table)}
                 ALTER COLUMN ${quote_ident(column)} SET DEFAULT gen_random_uuid()`,
            );
        }
        return;
    }
    if (dt !== 'integer' && dt !== 'bigint') return;

    if (opts.drop_default) {
        await sequelize.query(
            `ALTER TABLE public.${quote_ident(table)}
             ALTER COLUMN ${quote_ident(column)} DROP DEFAULT`,
        );
    }

    // Drop owned sequence if this was SERIAL
    await sequelize.query(`
        DO $$
        DECLARE seq regclass;
        BEGIN
            SELECT pg_get_serial_sequence('public.${table.replace(/'/g, "''")}', '${column.replace(/'/g, "''")}')
                INTO seq;
            IF seq IS NOT NULL THEN
                EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP DEFAULT', '${table}', '${column}');
                EXECUTE format('DROP SEQUENCE IF EXISTS %s CASCADE', seq);
            END IF;
        END $$;
    `);

    await sequelize.query(`
        ALTER TABLE public.${quote_ident(table)}
        ALTER COLUMN ${quote_ident(column)} TYPE uuid USING ${LEGACY(quote_ident(column))}
    `);

    if (opts.set_uuid_default) {
        await sequelize.query(
            `ALTER TABLE public.${quote_ident(table)}
             ALTER COLUMN ${quote_ident(column)} SET DEFAULT gen_random_uuid()`,
        );
    }
}

async function alter_nullable_int_fk_to_uuid(
    sequelize: Sequelize,
    table: string,
    column: string,
): Promise<void> {
    const dt = await column_data_type(sequelize, table, column);
    if (!dt || dt === 'uuid') return;
    if (dt !== 'integer' && dt !== 'bigint') return;
    await sequelize.query(`
        ALTER TABLE public.${quote_ident(table)}
        ALTER COLUMN ${quote_ident(column)} TYPE uuid
        USING CASE WHEN ${quote_ident(column)} IS NULL THEN NULL
                   ELSE ${LEGACY(quote_ident(column))} END
    `);
}

/**
 * If Hub still has integer `users.id`, convert all Hub PKs/FKs to UUID in place.
 * Safe to re-run: no-ops when users.id is already uuid.
 */
export async function migrate_hub_integer_pks_to_uuid(sequelize: Sequelize): Promise<void> {
    await sequelize.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    if (!(await users_id_is_uuid(sequelize))) {
        await migrate_public_integer_pks(sequelize);
    }

    // Always safe / idempotent: widen BFF session ids + cliq org_id FKs.
    await migrate_bff_session_user_ids(sequelize);
    await convert_cliq_org_id_columns(sequelize);
}

async function migrate_public_integer_pks(sequelize: Sequelize): Promise<void> {
    // Drop FKs so column type changes can proceed.
    await drop_all_fks_on_public(sequelize);

    // Primary keys (parents first for clarity; FKs already dropped).
    await alter_int_to_uuid(sequelize, 'users', 'id', { drop_default: true, set_uuid_default: true });
    await alter_int_to_uuid(sequelize, 'orgs', 'id', { drop_default: true, set_uuid_default: true });
    await alter_int_to_uuid(sequelize, 'scopes', 'id', { drop_default: true, set_uuid_default: true });
    await alter_int_to_uuid(sequelize, 'org_roles', 'id', { drop_default: true, set_uuid_default: true });
    await alter_int_to_uuid(sequelize, 'teams', 'id', { drop_default: true, set_uuid_default: true });
    await alter_int_to_uuid(sequelize, 'team_versions', 'id', { drop_default: true, set_uuid_default: true });
    await alter_int_to_uuid(sequelize, 'drafts', 'id', { drop_default: true, set_uuid_default: true });
    await alter_int_to_uuid(sequelize, 'audit_log', 'id', { drop_default: true, set_uuid_default: true });
    await alter_int_to_uuid(sequelize, 'account_invites', 'id', { drop_default: true, set_uuid_default: true });
    await alter_int_to_uuid(sequelize, 'realm_invites', 'id', { drop_default: true, set_uuid_default: true });

    // Foreign keys / composites
    await alter_int_to_uuid(sequelize, 'org_members', 'org_id');
    await alter_int_to_uuid(sequelize, 'org_members', 'user_id');
    await alter_nullable_int_fk_to_uuid(sequelize, 'org_members', 'role_id');

    await alter_int_to_uuid(sequelize, 'scopes', 'owner_id');
    await alter_nullable_int_fk_to_uuid(sequelize, 'scopes', 'org_id');
    await alter_nullable_int_fk_to_uuid(sequelize, 'orgs', 'default_scope_id');

    await alter_int_to_uuid(sequelize, 'scope_members', 'scope_id');
    await alter_int_to_uuid(sequelize, 'scope_members', 'user_id');

    await alter_nullable_int_fk_to_uuid(sequelize, 'teams', 'author_id');
    await alter_int_to_uuid(sequelize, 'team_versions', 'team_id');
    await alter_int_to_uuid(sequelize, 'team_tags', 'team_id');
    await alter_int_to_uuid(sequelize, 'download_log', 'team_id');

    await alter_int_to_uuid(sequelize, 'tokens', 'user_id');
    await alter_int_to_uuid(sequelize, 'drafts', 'user_id');
    await alter_int_to_uuid(sequelize, 'audit_log', 'admin_id');

    await alter_int_to_uuid(sequelize, 'org_roles', 'org_id');
    await alter_int_to_uuid(sequelize, 'account_invites', 'org_id');
    await alter_int_to_uuid(sequelize, 'account_invites', 'invited_by');
    await alter_nullable_int_fk_to_uuid(sequelize, 'account_invites', 'accepted_user_id');

    await alter_int_to_uuid(sequelize, 'realm_invites', 'invited_by');
    await alter_nullable_int_fk_to_uuid(sequelize, 'realm_invites', 'accepted_user_id');

    await alter_int_to_uuid(sequelize, 'org_agent_settings', 'org_id');
    await alter_nullable_int_fk_to_uuid(sequelize, 'org_agent_settings', 'updated_by');
    await alter_int_to_uuid(sequelize, 'account_agent_settings', 'user_id');
    await alter_int_to_uuid(sequelize, 'realm_agent_settings', 'user_id');

    // Recreate foreign keys
    const fks: Array<[string, string, string, string, string]> = [
        // child_table, column, parent_table, parent_col, on_delete
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
        const child_dt = await column_data_type(sequelize, child, col);
        const parent_exists = await column_data_type(sequelize, parent, pcol);
        if (!child_dt || !parent_exists) continue;
        const cname = `${child}_${col}_fkey`;
        await sequelize.query(`
            ALTER TABLE public.${quote_ident(child)}
            DROP CONSTRAINT IF EXISTS ${quote_ident(cname)}
        `);
        await sequelize.query(`
            ALTER TABLE public.${quote_ident(child)}
            ADD CONSTRAINT ${quote_ident(cname)}
            FOREIGN KEY (${quote_ident(col)}) REFERENCES public.${quote_ident(parent)}(${quote_ident(pcol)})
            ON DELETE ${on_delete}
        `);
    }
}

async function migrate_bff_session_user_ids(sequelize: Sequelize): Promise<void> {
    const sess = await sequelize.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'bff' AND table_name = 'sessions' AND column_name = 'user_id'`,
        { type: QueryTypes.SELECT },
    );
    if (sess[0]?.data_type === 'integer' || sess[0]?.data_type === 'bigint') {
        await sequelize.query(`
            ALTER TABLE bff.sessions
            ALTER COLUMN user_id TYPE TEXT
            USING ('00000000-0000-4000-8000-' || lpad(to_hex(user_id::bigint), 12, '0'))
        `);
    }
    const act = await sequelize.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'bff' AND table_name = 'sessions' AND column_name = 'act_as_user_id'`,
        { type: QueryTypes.SELECT },
    );
    if (act[0]?.data_type === 'integer' || act[0]?.data_type === 'bigint') {
        await sequelize.query(`
            ALTER TABLE bff.sessions
            ALTER COLUMN act_as_user_id TYPE TEXT
            USING ('00000000-0000-4000-8000-' || lpad(to_hex(act_as_user_id::bigint), 12, '0'))
        `);
    }
}

async function convert_cliq_org_id_columns(sequelize: Sequelize): Promise<void> {
    const tables = [
        'realms',
        'reviews',
        'in_app_notifications',
        'team_runs',
        'notification_channels',
        'notification_rules',
    ];
    for (const table of tables) {
        const rows = await sequelize.query<{ data_type: string }>(
            `SELECT data_type FROM information_schema.columns
             WHERE table_schema = 'cliq' AND table_name = :table AND column_name = 'org_id'`,
            { replacements: { table }, type: QueryTypes.SELECT },
        );
        if (!rows[0]) continue;
        if (rows[0].data_type === 'uuid') continue;
        if (rows[0].data_type !== 'integer' && rows[0].data_type !== 'bigint') continue;
        await sequelize.query(`
            ALTER TABLE cliq.${quote_ident(table)}
            ALTER COLUMN org_id DROP NOT NULL
        `).catch(() => undefined);
        await sequelize.query(`
            ALTER TABLE cliq.${quote_ident(table)}
            ALTER COLUMN org_id TYPE uuid
            USING CASE WHEN org_id IS NULL THEN NULL
                       ELSE ('00000000-0000-4000-8000-' || lpad(to_hex(org_id::bigint), 12, '0'))::uuid
                  END
        `);
    }
}
