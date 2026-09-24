/**
 * Idempotent Hub (public schema) upgrades for local / e2e / Railway DBs.
 */

import { QueryTypes, type Sequelize } from 'sequelize';
import { migrate_hub_integer_pks_to_uuid } from './migrate_hub_uuid_pks.js';
import { migrate_remaining_integer_pks_to_uuid } from './migrate_remaining_int_pks.js';
import { migrate_hub_remint_legacy_uuids } from './migrate_hub_remint_uuids.js';
import { migrate_repair_realm_user_refs } from './migrate_repair_realm_user_refs.js';

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

export async function migrate_hub_schema(sequelize: Sequelize): Promise<void> {
    // Convert legacy integer PKs → UUID before any CREATE that references users/orgs.
    await migrate_hub_integer_pks_to_uuid(sequelize);
    // Remaining SERIAL/int PKs (notification_*, run_logs, …) → random UUID.
    await migrate_remaining_integer_pks_to_uuid(sequelize);
    // Remint deterministic hub_legacy_uuid(n) values → gen_random_uuid().
    await migrate_hub_remint_legacy_uuids(sequelize);
    // Fix realms/realm_members TEXT user refs left as bare ints after UUID remint.
    await migrate_repair_realm_user_refs(sequelize);

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

    // Realm-scoped agent settings — snapshot copies from account_agent_settings
    // that a realm can diverge freely. Realm rows are in cliq schema so we
    // cannot FK realm_id directly; we clean up in RealmService.remove instead.
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS realm_agent_settings (
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
        CREATE INDEX IF NOT EXISTS realm_agent_settings_user_realm_idx
        ON realm_agent_settings (user_id, realm_id)
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS realm_agent_settings_realm_idx
        ON realm_agent_settings (realm_id)
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

}
