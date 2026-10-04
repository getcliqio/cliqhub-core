/**
 * Idempotent Hub (public schema) upgrades for local / e2e / Railway DBs.
 */

import { QueryTypes, type Sequelize } from 'sequelize';
import { migrate_hub_integer_pks_to_uuid } from './migrate_hub_uuid_pks.js';
import { migrate_remaining_integer_pks_to_uuid } from './migrate_remaining_int_pks.js';
import { migrate_hub_remint_legacy_uuids } from './migrate_hub_remint_uuids.js';
import { migrate_identity_lifecycle } from './migrate_identity_lifecycle.js';
const REGISTRY_TABLES = [
    'users',
    'orgs',
    'org_members',
    'scopes',
    'scope_members',
    'teams',
    'team_versions',
    'team_tags',
    'settings',
    'tokens',
    'audit_log',
    'download_log',
    'drafts',
    'org_roles',
    'org_agent_settings',
    'account_agent_settings',
    'account_invites',
    'realm_invites',
    // NOTE: realm_agent_settings is handled separately below — renamed to
    // user_realm_agent_settings to avoid conflict with store's cliq.realm_agent_settings.
] as const;

/**
 * Move all registry tables from `public` to the `cliq` schema.
 * Idempotent: each table is only moved if it still lives in `public`
 * and does not yet exist in `cliq`.  Must be called BEFORE sequelize.sync()
 * so that sync finds the tables in their final location and does not recreate
 * empty copies in `cliq`.
 */
export async function move_registry_to_cliq_schema(sequelize: Sequelize): Promise<void> {
    // ── Pre-flight: rename legacy daemon-catalog tables that share names with Hub
    // registry tables.  These were created by the old cliq-store package
    // (daemon catalog: scopes/teams with TEXT ids, not UUID) and are no longer
    // actively written.  Renaming them unblocks the registry migration below.
    // Detection: daemon `scopes` has an `is_default` column; daemon `teams`
    // has a `daemon_id` column — neither exists on the Hub registry models.
    await rename_daemon_catalog_table_if_present(sequelize, 'scopes', 'is_default', 'legacy_catalog_scopes');
    await rename_daemon_catalog_table_if_present(sequelize, 'teams', 'daemon_id', 'legacy_catalog_teams');

    // `public.reviews` is an orphaned legacy table (minimal columns, ≤ a handful
    // of rows).  The control-plane `cliq.reviews` (gate reviews) is the live one.
    // Drop the public remnant so it doesn't block future migrations.
    const pub_reviews = await table_exists(sequelize, 'public', 'reviews');
    if (pub_reviews) {
        await sequelize.query('DROP TABLE IF EXISTS public."reviews" CASCADE');
    }

    for (const tbl of REGISTRY_TABLES) {
        const in_public = await table_exists(sequelize, 'public', tbl);
        const in_cliq = await table_exists(sequelize, 'cliq', tbl);
        if (in_public && !in_cliq) {
            await sequelize.query(`ALTER TABLE public."${tbl}" SET SCHEMA cliq`);
        }
    }

    // Hub registry's realm_agent_settings (per-user per-realm) must be renamed to
    // user_realm_agent_settings to avoid collision with the store's cliq.realm_agent_settings
    // (per-realm, different schema — no user_id column).
    // Handle all possible states across multiple boots:
    const hub_ras_in_public = await table_exists(sequelize, 'public', 'realm_agent_settings');
    const old_renamed_in_public = await table_exists(sequelize, 'public', 'user_realm_agent_settings');
    const renamed_in_cliq = await table_exists(sequelize, 'cliq', 'user_realm_agent_settings');

    if (!renamed_in_cliq) {
        if (hub_ras_in_public && !old_renamed_in_public) {
            await sequelize.query(`ALTER TABLE public."realm_agent_settings" RENAME TO "user_realm_agent_settings"`);
        }
        if (hub_ras_in_public || old_renamed_in_public) {
            // Rename indexes that conflict with store's cliq.realm_agent_settings indexes.
            await sequelize.query(`ALTER INDEX IF EXISTS public."realm_agent_settings_pkey" RENAME TO "user_realm_agent_settings_pkey"`);
            await sequelize.query(`ALTER INDEX IF EXISTS public."realm_agent_settings_realm_idx" RENAME TO "user_realm_agent_settings_realm_idx"`);
            await sequelize.query(`ALTER INDEX IF EXISTS public."realm_agent_settings_user_realm_idx" RENAME TO "user_realm_agent_settings_user_realm_idx"`);
            await sequelize.query(`ALTER TABLE public."user_realm_agent_settings" SET SCHEMA cliq`);
        }
    } else if (hub_ras_in_public || old_renamed_in_public) {
        // cliq already has it (created by sync or a previous boot); drop public remnants.
        if (hub_ras_in_public) {
            await sequelize.query(`DROP TABLE IF EXISTS public."realm_agent_settings" CASCADE`);
        }
        if (old_renamed_in_public) {
            await sequelize.query(`DROP TABLE IF EXISTS public."user_realm_agent_settings" CASCADE`);
        }
    }
}

async function table_exists(
    sequelize: Sequelize,
    schema: string,
    table: string,
): Promise<boolean> {
    const rows = await sequelize.query<{ exists: boolean }>(
        `SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = :schema AND table_name = :table
        ) AS exists`,
        { replacements: { schema, table }, type: QueryTypes.SELECT },
    );
    return Boolean(rows[0]?.exists);
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

/**
 * Rename a daemon-catalog table in the `cliq` schema to `new_name` when the
 * given `sentinel_column` exists (proving it is the daemon-format table and
 * not a Hub registry table).  Idempotent — does nothing if the table is
 * absent or the sentinel column is missing.
 */
async function rename_daemon_catalog_table_if_present(
    sequelize: Sequelize,
    table: string,
    sentinel_column: string,
    new_name: string,
): Promise<void> {
    const exists = await table_exists(sequelize, 'cliq', table);
    if (!exists) return;
    const has_sentinel = await column_exists(sequelize, 'cliq', table, sentinel_column);
    if (!has_sentinel) return;
    const already_renamed = await table_exists(sequelize, 'cliq', new_name);
    if (already_renamed) {
        // Already renamed in a previous boot — drop the old daemon table if
        // it still exists (can happen if a prior rename was interrupted).
        await sequelize.query(`DROP TABLE IF EXISTS cliq."${table}" CASCADE`);
        return;
    }
    await sequelize.query(`ALTER TABLE cliq."${table}" RENAME TO "${new_name}"`);
}

export async function migrate_hub_schema(sequelize: Sequelize): Promise<void> {
    // Convert legacy integer PKs → UUID before any CREATE that references users/orgs.
    await migrate_hub_integer_pks_to_uuid(sequelize);
    // Remaining SERIAL/int PKs (notification_*, run_logs, …) → random UUID.
    await migrate_remaining_integer_pks_to_uuid(sequelize);
    // Remint deterministic hub_legacy_uuid(n) values → gen_random_uuid().
    await migrate_hub_remint_legacy_uuids(sequelize);
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS tokens (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL DEFAULT '',
            token_hash TEXT NOT NULL,
            token_prefix TEXT,
            permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
            last_used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            revoked_at TIMESTAMPTZ
        )
    `);

    // JIRA plugin slice 1.6: capability scopes on API tokens.
    // Empty array = legacy full-power token (backward compat).
    // Non-empty = least-privilege: enforced by require_token_scope
    // middleware on Forge-facing routes (dispatch, read:realms).
    await sequelize.query(`
        ALTER TABLE tokens
        ADD COLUMN IF NOT EXISTS "scopes" JSONB NOT NULL DEFAULT '[]'::jsonb
    `);

    await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS tokens_token_hash_uidx ON tokens (token_hash)
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS tokens_token_prefix_idx ON tokens (token_prefix)
        WHERE token_prefix IS NOT NULL
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS tokens_user_id_type_idx ON tokens (user_id, type)
    `);

    if (await table_exists(sequelize, 'public', 'api_tokens')) {
        await sequelize.query(`
            INSERT INTO tokens (
                id, type, user_id, name, token_hash, token_prefix,
                permissions, last_used_at, created_at, revoked_at
            )
            SELECT
                'migrated-pat-' || a.id::text,
                'user',
                a.user_id,
                a.name,
                a.token_hash,
                a.token_prefix,
                COALESCE(a.permissions, '{}'::jsonb),
                a.last_used_at,
                a.created_at,
                NULL
            FROM api_tokens a
            WHERE NOT EXISTS (
                SELECT 1 FROM tokens t WHERE t.id = 'migrated-pat-' || a.id::text
            )
        `);
    }

    if (await table_exists(sequelize, 'cliq', 'realm_tokens')) {
        await sequelize.query(`
            INSERT INTO tokens (
                id, type, user_id, name, token_hash, token_prefix,
                permissions, last_used_at, created_at, revoked_at
            )
            SELECT
                r.id,
                'realm',
                CASE
                    WHEN r.created_by ~ '^[0-9]+$'
                    THEN ('00000000-0000-4000-8000-' || lpad(to_hex(r.created_by::bigint), 12, '0'))::uuid
                    ELSE r.created_by::uuid
                END,
                r.name,
                r.token_hash,
                NULL,
                CASE
                    WHEN COALESCE(r.permissions, '{}'::jsonb) = '{}'::jsonb
                        OR (r.permissions->'domains'->'realms') IS NULL
                    THEN jsonb_build_object(
                        'domains', jsonb_build_object('realms', jsonb_build_array(r.realm_id)),
                        'access', COALESCE(r.permissions->'access', '{}'::jsonb)
                    )
                    ELSE r.permissions
                END,
                NULL,
                to_timestamp(r.created_at / 1000.0),
                CASE WHEN r.revoked_at IS NULL THEN NULL
                     ELSE to_timestamp(r.revoked_at / 1000.0)
                END
            FROM cliq.realm_tokens r
            WHERE EXISTS (
                SELECT 1 FROM users u
                WHERE u.id::text = r.created_by
                   OR (
                        r.created_by ~ '^[0-9]+$'
                        AND u.id = ('00000000-0000-4000-8000-' || lpad(to_hex(r.created_by::bigint), 12, '0'))::uuid
                   )
            )
            AND NOT EXISTS (
                SELECT 1 FROM tokens t WHERE t.id = r.id
            )
        `);
    }

    // Hard cutover: only user | realm remain. No aliases.
    await sequelize.query(`
        UPDATE tokens SET type = 'realm' WHERE type IN ('daemon', 'realm_token')
    `);
    await sequelize.query(`
        UPDATE tokens SET type = 'user' WHERE type IN ('personal', 'pat', 'api')
    `);
    // Fail loudly if anything else remains (forces a conscious migration for unknown types).
    const leftover = await sequelize.query<{ type: string; n: string }>(
        `SELECT type, COUNT(*)::text AS n FROM tokens
         WHERE type NOT IN ('user', 'realm')
         GROUP BY type`,
        { type: QueryTypes.SELECT },
    );
    if (leftover.length > 0) {
        const detail = leftover.map((r) => `${r.type}=${r.n}`).join(', ');
        throw new Error(`tokens.type migration incomplete; unexpected types: ${detail}`);
    }

    // Legacy tables superseded by public.tokens — drop after copy.
    await sequelize.query(`DROP TABLE IF EXISTS api_tokens`);
    await sequelize.query(`DROP TABLE IF EXISTS cliq.realm_tokens`);

    await sequelize.query(`
        ALTER TABLE orgs
        ADD COLUMN IF NOT EXISTS default_scope_id UUID
    `);

    // Org-level mesh / A2A defaults (Svantic provider settings, auto-enable).
    await sequelize.query(`
        ALTER TABLE orgs
        ADD COLUMN IF NOT EXISTS mesh_active_provider_id TEXT
    `);
    await sequelize.query(`
        ALTER TABLE orgs
        ADD COLUMN IF NOT EXISTS mesh_providers JSONB NOT NULL DEFAULT '{}'::jsonb
    `);
    await sequelize.query(`
        ALTER TABLE orgs
        ADD COLUMN IF NOT EXISTS mesh_auto_enable_a2a_on_realm_create BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // Account-owned realms: personal default on user; orgs no longer parent realms.
    await sequelize.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS default_realm_id TEXT
    `);
    await sequelize.query(`
        ALTER TABLE orgs
        DROP COLUMN IF EXISTS default_realm_id
    `);

    // Account invites: pending email invites join an existing Account (no new Account on accept).
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS account_invites (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            email TEXT NOT NULL,
            invited_by UUID NOT NULL REFERENCES users(id),
            token_hash TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL DEFAULT 'member',
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL,
            accepted_at TIMESTAMPTZ,
            accepted_user_id UUID REFERENCES users(id)
        )
    `);
    await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS account_invites_pending_org_email_uidx
        ON account_invites (org_id, lower(email))
        WHERE status = 'pending'
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS account_invites_org_id_idx
        ON account_invites (org_id)
    `);

    // Realm invites: pending email invites join an existing realm (no new account on accept).
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS realm_invites (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            realm_id TEXT NOT NULL,
            email TEXT NOT NULL,
            invited_by UUID NOT NULL REFERENCES users(id),
            token_hash TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL DEFAULT 'member',
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL,
            accepted_at TIMESTAMPTZ,
            accepted_user_id UUID REFERENCES users(id)
        )
    `);
    await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS realm_invites_pending_realm_email_uidx
        ON realm_invites (realm_id, lower(email))
        WHERE status = 'pending'
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS realm_invites_realm_id_idx
        ON realm_invites (realm_id)
    `);

    // ── Org-as-account: roles + org-scoped agent settings ─────────────

    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS org_roles (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            slug TEXT NOT NULL,
            name TEXT NOT NULL,
            permissions TEXT[] NOT NULL DEFAULT '{}',
            is_system BOOLEAN NOT NULL DEFAULT FALSE,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS org_roles_org_slug_uidx
        ON org_roles (org_id, slug)
    `);

    await sequelize.query(`
        ALTER TABLE org_members
        ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES org_roles(id)
    `);

    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS org_agent_settings (
            org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            agent_name TEXT NOT NULL,
            setting_key TEXT NOT NULL,
            value TEXT NOT NULL DEFAULT '',
            updated_by UUID REFERENCES users(id),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (org_id, agent_name, setting_key)
        )
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS org_agent_settings_org_idx
        ON org_agent_settings (org_id)
    `);

    // Account-level agent settings: per-user defaults for each agent's
    // configurable settings (API keys, endpoints, etc.). Composite PK
    // so the same user can have many settings across many agents but
    // never duplicates for a single (agent, key) pair.
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS account_agent_settings (
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            agent_name TEXT NOT NULL,
            setting_key TEXT NOT NULL,
            value TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, agent_name, setting_key)
        )
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS account_agent_settings_user_idx
        ON account_agent_settings (user_id)
    `);

    // Per-user per-realm agent settings — snapshot copies from account_agent_settings
    // that a realm can diverge freely. Named user_realm_agent_settings to avoid
    // collision with store's realm_agent_settings (per-realm, no user_id).
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS user_realm_agent_settings (
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            realm_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            setting_key TEXT NOT NULL,
            value TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, realm_id, agent_name, setting_key)
        )
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS user_realm_agent_settings_user_realm_idx
        ON user_realm_agent_settings (user_id, realm_id)
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS user_realm_agent_settings_realm_idx
        ON user_realm_agent_settings (realm_id)
    `);

    // Per-user preferences — general-purpose JSON bag for UI settings,
    // alert toggles, etc. Defaults to empty object.
    await sequelize.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'
    `);

    // Raw team.yml text preserved verbatim per published version.
    // Existing rows get '' (empty) — those fall back to the reconstructed YAML.
    await sequelize.query(`
        ALTER TABLE team_versions
        ADD COLUMN IF NOT EXISTS manifest_yaml TEXT NOT NULL DEFAULT ''
    `);

    await sequelize.query(`
        DO $$ BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'cliq' AND table_name = 'runs'
            ) THEN
                ALTER TABLE cliq.runs ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES cliq.orgs(id) ON DELETE SET NULL;
                UPDATE cliq.runs SET org_id = r.org_id FROM cliq.realms r
                    WHERE cliq.runs.realm_id = r.id AND cliq.runs.org_id IS NULL;
                IF NOT EXISTS (
                    SELECT 1 FROM pg_indexes
                    WHERE schemaname = 'cliq' AND indexname = 'runs_org_id_run_name_uidx'
                ) THEN
                    BEGIN
                        CREATE UNIQUE INDEX runs_org_id_run_name_uidx
                            ON cliq.runs (org_id, run_name)
                            WHERE org_id IS NOT NULL AND run_name IS NOT NULL;
                    EXCEPTION WHEN unique_violation THEN
                        NULL;
                    END;
                END IF;
            END IF;
        END $$
    `);
    // Audit history outlives the admin who wrote it: the old association made
    // audit_log.admin_id cascade on user delete. Drop it (idempotent).
    await sequelize.query('ALTER TABLE IF EXISTS cliq.audit_log DROP CONSTRAINT IF EXISTS audit_log_admin_id_fkey');

    // User / org status and soft delete, pending memberships, tracked invite and
    // password links, system notification rows, email delivery log.
    await migrate_identity_lifecycle(sequelize);
}
