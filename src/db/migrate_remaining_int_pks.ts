/**
 * Convert remaining Hub-owned INTEGER/SERIAL primary keys to UUID.
 *
 * Store-owned run leaf tables (run_logs, team_run_events, run_artifacts)
 * are converted in @getcliqio/cliq-store migrate_store().
 */

import { QueryTypes, type Sequelize } from 'sequelize';

function quote_ident(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

async function pk_data_type(
    sequelize: Sequelize,
    schema: string,
    table: string,
    column: string,
): Promise<string | null> {
    const rows = await sequelize.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = :schema AND table_name = :table AND column_name = :column`,
        { replacements: { schema, table, column }, type: QueryTypes.SELECT },
    );
    return rows[0]?.data_type ?? null;
}

async function convert_int_pk_to_uuid(
    sequelize: Sequelize,
    schema: string,
    table: string,
    column = 'id',
): Promise<void> {
    const dt = await pk_data_type(sequelize, schema, table, column);
    if (!dt) return;
    if (dt === 'uuid') {
        await sequelize.query(`
            ALTER TABLE ${quote_ident(schema)}.${quote_ident(table)}
            ALTER COLUMN ${quote_ident(column)} SET DEFAULT gen_random_uuid()
        `).catch(() => undefined);
        return;
    }
    if (dt !== 'integer' && dt !== 'bigint') return;

    await sequelize.query(`
        DO $$
        DECLARE seq regclass;
        BEGIN
            SELECT pg_get_serial_sequence('${schema}.${table}', '${column}') INTO seq;
            IF seq IS NOT NULL THEN
                EXECUTE format(
                    'ALTER TABLE %I.%I ALTER COLUMN %I DROP DEFAULT',
                    '${schema}', '${table}', '${column}'
                );
                EXECUTE format('DROP SEQUENCE IF EXISTS %s CASCADE', seq);
            END IF;
        END $$;
    `);

    const new_col = `${column}_uuid`;
    await sequelize.query(`
        ALTER TABLE ${quote_ident(schema)}.${quote_ident(table)}
        ADD COLUMN IF NOT EXISTS ${quote_ident(new_col)} UUID
    `);
    await sequelize.query(`
        UPDATE ${quote_ident(schema)}.${quote_ident(table)}
        SET ${quote_ident(new_col)} = gen_random_uuid()
        WHERE ${quote_ident(new_col)} IS NULL
    `);
    await sequelize.query(`
        ALTER TABLE ${quote_ident(schema)}.${quote_ident(table)}
        ALTER COLUMN ${quote_ident(new_col)} SET NOT NULL
    `);
    await sequelize.query(`
        ALTER TABLE ${quote_ident(schema)}.${quote_ident(table)}
        ALTER COLUMN ${quote_ident(new_col)} SET DEFAULT gen_random_uuid()
    `);

    const pks = await sequelize.query<{ constraint_name: string }>(
        `SELECT tc.constraint_name
         FROM information_schema.table_constraints tc
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = :schema AND tc.table_name = :table`,
        { replacements: { schema, table }, type: QueryTypes.SELECT },
    );
    for (const pk of pks) {
        await sequelize.query(`
            ALTER TABLE ${quote_ident(schema)}.${quote_ident(table)}
            DROP CONSTRAINT IF EXISTS ${quote_ident(pk.constraint_name)}
        `);
    }

    await sequelize.query(`
        ALTER TABLE ${quote_ident(schema)}.${quote_ident(table)}
        DROP COLUMN ${quote_ident(column)}
    `);
    await sequelize.query(`
        ALTER TABLE ${quote_ident(schema)}.${quote_ident(table)}
        RENAME COLUMN ${quote_ident(new_col)} TO ${quote_ident(column)}
    `);
    await sequelize.query(`
        ALTER TABLE ${quote_ident(schema)}.${quote_ident(table)}
        ADD PRIMARY KEY (${quote_ident(column)})
    `);
}

/**
 * Migrate leftover Hub-owned integer PKs.
 * Drops superseded public.daemon_tokens tables (replaced by public.tokens).
 */
export async function migrate_remaining_integer_pks_to_uuid(sequelize: Sequelize): Promise<void> {
    await sequelize.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    for (const table of [
        'notification_rules',
        'notification_subscriptions',
        'custom_events',
        'model_pricing',
    ]) {
        await convert_int_pk_to_uuid(sequelize, 'cliq', table, 'id');
    }

    await convert_int_pk_to_uuid(sequelize, 'public', 'chat_messages', 'id');

    await sequelize.query(`DROP TABLE IF EXISTS public.daemon_token_orgs CASCADE`);
    await sequelize.query(`DROP TABLE IF EXISTS public.daemon_tokens CASCADE`);
}
