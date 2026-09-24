/**
 * Idempotent schema migrations for Hub-mounted control plane (ported from Core BFF).
 * Each statement uses IF NOT EXISTS / safe checks so it can re-run.
 */

import type { Sequelize } from 'sequelize';
import yaml from 'js-yaml';

export async function run_core_api_schema_migrations(sq: Sequelize): Promise<void> {
    /** Run a single idempotent DDL statement, swallowing "already exists" errors. */
    const run = async (sql: string) => {
        try {
            await sq.query(sql);
        } catch {
            /* already applied or not applicable */
        }
    };

    await run(`ALTER TABLE cliq."daemons" ADD COLUMN IF NOT EXISTS "public_url" TEXT`);
    await run(`ALTER TABLE cliq."daemons" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'online'`);
    await run(`ALTER TABLE cliq."daemons" ADD COLUMN IF NOT EXISTS "last_heartbeat" BIGINT`);
    await run(`ALTER TABLE cliq."daemons" ADD COLUMN IF NOT EXISTS "capacity" INTEGER DEFAULT 5`);
    await run(`ALTER TABLE cliq."daemons" ADD COLUMN IF NOT EXISTS "name" TEXT`);

    await run(`ALTER TABLE cliq."workspaces" ADD COLUMN IF NOT EXISTS "daemon_id" TEXT`);
    await run(`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "daemon_id" TEXT`);
    await run(`ALTER TABLE cliq."containers" ADD COLUMN IF NOT EXISTS "daemon_id" TEXT`);

    await run(`ALTER TABLE cliq."teams" ADD COLUMN IF NOT EXISTS "daemon_id" TEXT`);
    await run(`ALTER TABLE cliq."teams" DROP CONSTRAINT IF EXISTS "teams_scope_id_slug_key"`);
    await run(`DROP INDEX IF EXISTS cliq."teams_scope_id_slug"`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "teams_daemon_scope_slug_uniq"
               ON cliq."teams" ("daemon_id", "scope_id", "slug")
               WHERE "daemon_id" IS NOT NULL`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "teams_scope_slug_legacy_uniq"
               ON cliq."teams" ("scope_id", "slug")
               WHERE "daemon_id" IS NULL`);

    await run(`ALTER TABLE cliq."daemon_config" ADD COLUMN IF NOT EXISTS "daemon_id" TEXT DEFAULT '__global__'`);
    await run(`UPDATE cliq."daemon_config" SET "daemon_id" = '__global__' WHERE "daemon_id" IS NULL`);
    await run(`ALTER TABLE cliq."daemon_config" DROP CONSTRAINT IF EXISTS "daemon_config_pkey"`);
    await run(`ALTER TABLE cliq."daemon_config" ADD PRIMARY KEY ("daemon_id", "key")`);

    await run(`ALTER TABLE cliq."scopes" ADD COLUMN IF NOT EXISTS "org_id" TEXT`);
    await run(`ALTER TABLE cliq."scopes" ADD COLUMN IF NOT EXISTS "scope_type" TEXT`);

    await run(`DROP TABLE IF EXISTS cliq."bundles"`);

    // Store `cliq.agents` may exist on Hub Postgres via shared migrations; Hub SoT
    // for platform agents is `agent_catalog` only — do not seed/CRUD catalog rows here.
    await run(`ALTER TABLE cliq."agents" ADD COLUMN IF NOT EXISTS "daemon_id" TEXT`);

    await run(`CREATE TABLE IF NOT EXISTS cliq."org_dispatch_keys" (
        "org_id" TEXT PRIMARY KEY,
        "public_key_pem" TEXT NOT NULL,
        "private_key_pem" TEXT NOT NULL,
        "created_at" BIGINT NOT NULL,
        "rotated_at" BIGINT NOT NULL
    )`);

    await run(`CREATE TABLE IF NOT EXISTS cliq."notification_channels" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL UNIQUE,
        "provider" TEXT NOT NULL,
        "config" TEXT NOT NULL DEFAULT '{}',
        "enabled" INTEGER NOT NULL DEFAULT 1,
        "created_at" BIGINT NOT NULL,
        "updated_at" BIGINT NOT NULL
    )`);

    await run(`CREATE TABLE IF NOT EXISTS cliq."notification_subscriptions" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "realm_id" TEXT,
        "channel_id" TEXT NOT NULL,
        "event" TEXT NOT NULL,
        "scope" TEXT NOT NULL DEFAULT 'global',
        "created_at" BIGINT NOT NULL
    )`);

    await run(`DROP TABLE IF EXISTS cliq."sync_outbox"`);
    await run(`DROP TABLE IF EXISTS cliq."sync_cursor"`);

    await run(`CREATE TABLE IF NOT EXISTS cliq."realms" (
        "id" TEXT PRIMARY KEY,
        "slug" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "owner_user_id" TEXT NOT NULL,
        "created_by" TEXT NOT NULL,
        "created_at" BIGINT NOT NULL,
        "updated_at" BIGINT NOT NULL
    )`);
    // Account ownership — hard cut from org-parented realms.
    await run(`ALTER TABLE cliq."realms" ADD COLUMN IF NOT EXISTS "owner_user_id" TEXT`);
    await run(`UPDATE cliq."realms"
               SET "owner_user_id" = "created_by"
               WHERE "owner_user_id" IS NULL OR TRIM("owner_user_id") = ''`);
    await run(`CREATE INDEX IF NOT EXISTS "realms_owner_user_id_idx"
               ON cliq."realms" ("owner_user_id")`);
    await run(`CREATE TABLE IF NOT EXISTS cliq."realm_members" (
        "id" TEXT PRIMARY KEY,
        "realm_id" TEXT NOT NULL,
        "member_type" TEXT NOT NULL,
        "member_id" TEXT NOT NULL,
        "role" TEXT NOT NULL DEFAULT 'operator',
        "created_at" BIGINT NOT NULL
    )`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "realm_members_realm_type_id_uniq"
               ON cliq."realm_members" ("realm_id", "member_type", "member_id")`);
    await run(`CREATE INDEX IF NOT EXISTS "realm_members_member_lookup"
               ON cliq."realm_members" ("member_type", "member_id")`);
    await run(`DROP TABLE IF EXISTS cliq."realm_tokens"`);

    await run(`CREATE TABLE IF NOT EXISTS cliq."realm_dispatch_keys" (
        "realm_id" TEXT PRIMARY KEY,
        "public_key_pem" TEXT NOT NULL,
        "private_key_pem" TEXT NOT NULL,
        "created_at" BIGINT NOT NULL,
        "rotated_at" BIGINT NOT NULL
    )`);

    await run(`ALTER TABLE cliq."daemons" ADD COLUMN IF NOT EXISTS "permissions" JSONB NOT NULL DEFAULT '{}'::jsonb`);

    await run(`DROP TABLE IF EXISTS cliq."dispatch_request_history"`);
    await run(`DROP TABLE IF EXISTS cliq."dispatch_requests"`);

    await run(`CREATE TABLE IF NOT EXISTS cliq."events" (
        "id" TEXT PRIMARY KEY,
        "type" TEXT NOT NULL,
        "occurred_at" TEXT NOT NULL,
        "realm_id" TEXT,
        "org_id" TEXT,
        "team" TEXT,
        "run_id" TEXT,
        "phase" TEXT,
        "daemon_id" TEXT,
        "title" TEXT,
        "message" TEXT,
        "severity" TEXT,
        "payload_json" TEXT NOT NULL DEFAULT '{}',
        "actor_id" TEXT,
        "created_at" BIGINT NOT NULL
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "events_type_idx" ON cliq."events" ("type")`);
    await run(`CREATE INDEX IF NOT EXISTS "events_realm_id_idx" ON cliq."events" ("realm_id")`);
    await run(`CREATE INDEX IF NOT EXISTS "events_created_at_idx" ON cliq."events" ("created_at")`);

    // Notification subscriptions: realm-scoped + account-scoped bindings.
    await run(`ALTER TABLE cliq."notification_subscriptions"
               ADD COLUMN IF NOT EXISTS "realm_id" TEXT`);
    await run(`UPDATE cliq."notification_subscriptions"
               SET "scope" = 'realm:' || "realm_id"
               WHERE "realm_id" IS NOT NULL
                 AND TRIM("realm_id") <> ''
                 AND "scope" IS DISTINCT FROM ('realm:' || "realm_id")`);
    await run(`UPDATE cliq."notification_subscriptions"
               SET "scope" = 'account'
               WHERE "realm_id" IS NULL OR TRIM("realm_id") = ''`);
    // Allow NULL realm_id for account-scoped bindings.
    await run(`ALTER TABLE cliq."notification_subscriptions"
               ALTER COLUMN "realm_id" DROP NOT NULL`);
    await run(`DROP INDEX IF EXISTS cliq."notification_subscriptions_channel_id_event_scope"`);
    await run(`DROP INDEX IF EXISTS cliq."notification_subscriptions_realm_channel_event_uniq"`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "notification_subscriptions_realm_channel_event_uniq"
               ON cliq."notification_subscriptions" ("realm_id", "channel_id", "event")
               WHERE "realm_id" IS NOT NULL`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "notification_subscriptions_account_channel_event_uniq"
               ON cliq."notification_subscriptions" ("channel_id", "event")
               WHERE "realm_id" IS NULL`);
    await run(`CREATE INDEX IF NOT EXISTS "notification_subscriptions_realm_id_idx"
               ON cliq."notification_subscriptions" ("realm_id")`);
    await run(`CREATE INDEX IF NOT EXISTS "notification_subscriptions_realm_event_idx"
               ON cliq."notification_subscriptions" ("realm_id", "event")`);
    await run(`CREATE INDEX IF NOT EXISTS "notification_subscriptions_account_scope_idx"
               ON cliq."notification_subscriptions" ("scope")
               WHERE "realm_id" IS NULL`);

    // In-app notification rows written by the cliqhub channel deliverer.
    await run(`CREATE TABLE IF NOT EXISTS cliq."in_app_notifications" (
        "id" TEXT PRIMARY KEY,
        "event" TEXT NOT NULL,
        "title" TEXT,
        "message" TEXT,
        "realm_id" TEXT,
        "team" TEXT,
        "run_id" TEXT,
        "phase" TEXT,
        "severity" TEXT,
        "payload_json" TEXT NOT NULL DEFAULT '{}',
        "created_at" BIGINT NOT NULL
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "in_app_notifications_created_at_idx"
               ON cliq."in_app_notifications" ("created_at")`);
    await run(`CREATE INDEX IF NOT EXISTS "in_app_notifications_realm_id_idx"
               ON cliq."in_app_notifications" ("realm_id")`);
    await run(`CREATE INDEX IF NOT EXISTS "in_app_notifications_event_idx"
               ON cliq."in_app_notifications" ("event")`);

    // Realm-scoped notification channels (replace account-global channels).
    await run(`ALTER TABLE cliq."notification_channels"
               ADD COLUMN IF NOT EXISTS "realm_id" TEXT`);
    // Drop legacy global unique on name if present (constraint name varies).
    await run(`ALTER TABLE cliq."notification_channels"
               DROP CONSTRAINT IF EXISTS "notification_channels_name_key"`);
    await run(`DROP INDEX IF EXISTS cliq."notification_channels_name_key"`);

    // Per-realm in-app channel for every existing realm.
    await run(`INSERT INTO cliq."notification_channels"
               ("id", "realm_id", "name", "provider", "config", "enabled", "created_at", "updated_at")
               SELECT
                 'cliqhub-' || r."id",
                 r."id",
                 'cliqhub',
                 'cliqhub',
                 '{}',
                 1,
                 (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
                 (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
               FROM cliq."realms" r
               WHERE NOT EXISTS (
                 SELECT 1 FROM cliq."notification_channels" c
                 WHERE c."realm_id" = r."id" AND c."name" = 'cliqhub'
               )`);

    // Point realm bindings that used the global cliqhub seed at the per-realm channel.
    await run(`UPDATE cliq."notification_subscriptions" s
               SET "channel_id" = 'cliqhub-' || s."realm_id"
               WHERE s."realm_id" IS NOT NULL
                 AND TRIM(s."realm_id") <> ''
                 AND s."channel_id" IN (
                   SELECT c."id" FROM cliq."notification_channels" c
                   WHERE c."name" = 'cliqhub' AND (c."realm_id" IS NULL OR TRIM(c."realm_id") = '')
                 )
                 AND EXISTS (
                   SELECT 1 FROM cliq."notification_channels" c2
                   WHERE c2."id" = 'cliqhub-' || s."realm_id"
                 )`);

    // Drop orphan account-global channels (no longer used).
    await run(`DELETE FROM cliq."notification_subscriptions" s
               WHERE s."channel_id" IN (
                 SELECT c."id" FROM cliq."notification_channels" c
                 WHERE c."realm_id" IS NULL OR TRIM(c."realm_id") = ''
               )`);
    await run(`DELETE FROM cliq."notification_channels"
               WHERE "realm_id" IS NULL OR TRIM("realm_id") = ''`);

    await run(`DROP INDEX IF EXISTS cliq."notification_channels_realm_name_uidx"`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "notification_channels_realm_name_uidx"
               ON cliq."notification_channels" ("realm_id", "name")
               WHERE "realm_id" IS NOT NULL`);
    await run(`CREATE INDEX IF NOT EXISTS "notification_channels_realm_id_idx"
               ON cliq."notification_channels" ("realm_id")`);

    // Account-owned channels (realm_id NULL) + unique name among account channels.
    await run(`ALTER TABLE cliq."notification_channels"
               ALTER COLUMN "realm_id" DROP NOT NULL`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "notification_channels_account_name_uidx"
               ON cliq."notification_channels" ("name")
               WHERE "realm_id" IS NULL`);

    // HUG reviews live in Hub (not a separate hug service).
    await run(`CREATE TABLE IF NOT EXISTS cliq."reviews" (
        "id" TEXT PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "daemon_id" TEXT,
        "realm_id" TEXT,
        "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
        "verdict" JSONB,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "route_targets" JSONB,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "timeout_at" TIMESTAMPTZ NOT NULL,
        "completed_at" TIMESTAMPTZ
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "reviews_status_timeout_idx"
               ON cliq."reviews" ("status", "timeout_at")`);
    await run(`CREATE INDEX IF NOT EXISTS "reviews_run_id_idx"
               ON cliq."reviews" ("run_id")`);
    await run(`CREATE INDEX IF NOT EXISTS "reviews_realm_status_idx"
               ON cliq."reviews" ("realm_id", "status")`);

    await run(`CREATE TABLE IF NOT EXISTS cliq."review_chat_messages" (
        "id" TEXT PRIMARY KEY,
        "review_id" TEXT NOT NULL,
        "role" TEXT NOT NULL,
        "text" TEXT NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "review_chat_messages_review_id_idx"
               ON cliq."review_chat_messages" ("review_id")`);

    // Searchable per-line run logs (Datadog-style explorer).
    // chunk_id references cliq.run_logs.id (UUID text after leaf PK hard-cut).
    await run(`CREATE TABLE IF NOT EXISTS cliq."run_log_lines" (
        "id" TEXT PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "created_at" BIGINT NOT NULL,
        "level" TEXT NOT NULL DEFAULT 'info',
        "message" TEXT NOT NULL,
        "daemon_id" TEXT,
        "workspace_id" TEXT,
        "team" TEXT,
        "realm_id" TEXT,
        "chunk_id" TEXT
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "run_log_lines_created_at_idx"
               ON cliq."run_log_lines" ("created_at")`);
    await run(`CREATE INDEX IF NOT EXISTS "run_log_lines_realm_created_idx"
               ON cliq."run_log_lines" ("realm_id", "created_at")`);
    await run(`CREATE INDEX IF NOT EXISTS "run_log_lines_run_id_idx"
               ON cliq."run_log_lines" ("run_id")`);
    await run(`CREATE INDEX IF NOT EXISTS "run_log_lines_level_idx"
               ON cliq."run_log_lines" ("level")`);
    await run(`CREATE INDEX IF NOT EXISTS "run_log_lines_daemon_id_idx"
               ON cliq."run_log_lines" ("daemon_id")`);

    // Hard-cut: run_logs.id is UUID; widen legacy INTEGER chunk_id.
    await run(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'cliq'
                  AND table_name = 'run_log_lines'
                  AND column_name = 'chunk_id'
                  AND data_type IN ('integer', 'bigint', 'smallint')
            ) THEN
                ALTER TABLE cliq."run_log_lines"
                    ALTER COLUMN "chunk_id" TYPE TEXT USING "chunk_id"::text;
            END IF;
        END $$;
    `);

    // Concern facet — 'run' | 'system' | 'command' | 'http'. Nullable so
    // pre-migration rows read cleanly; back-fill everything historical
    // to 'run' since the log-line table was previously fed only by the
    // per-run mirror path.
    await run(`ALTER TABLE cliq."run_log_lines" ADD COLUMN IF NOT EXISTS "concern" TEXT`);
    await run(`UPDATE cliq."run_log_lines" SET "concern" = 'run' WHERE "concern" IS NULL`);
    await run(`CREATE INDEX IF NOT EXISTS "run_log_lines_concern_idx"
               ON cliq."run_log_lines" ("concern")`);

    // Daemon log mirror can race run create; allow orphan chunks (search
    // still indexes realm via daemon membership when the run row exists).
    await run(`ALTER TABLE cliq."run_logs" DROP CONSTRAINT IF EXISTS "run_logs_run_id_fkey"`);

    // Runs are historical — must not block team row cleanup on uninstall.
    await run(`ALTER TABLE cliq."team_runs" DROP CONSTRAINT IF EXISTS "team_runs_team_id_fkey"`);
    await run(`ALTER TABLE cliq."team_run_phases" DROP CONSTRAINT IF EXISTS "team_run_phases_run_id_fkey"`);

    // Personal default realms: display name is always `default` (slug/id stay unique).
    // Idempotent — no-ops once names are already `default`.
    await run(`
        UPDATE cliq."realms"
        SET "name" = 'default',
            "updated_at" = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        WHERE "name" IS DISTINCT FROM 'default'
          AND (
            "slug" LIKE 'r-%'
            OR "slug" LIKE 'u-%'
            OR "slug" LIKE '%-default-realm'
          )
    `);
    await run(`
        UPDATE cliq."realms" r
        SET "name" = 'default',
            "updated_at" = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        FROM "users" u
        WHERE u."default_realm_id" = r."id"
          AND r."name" IS DISTINCT FROM 'default'
    `);
    // Legacy personal-realm slug renames (r-<user> / u-<user> / *-default-realm)
    // were handled by the removed migrate_account_owned_realms boot migration.
    // All prod data has been converted to org-scoped slug='default'.

    // Realm user memberships must store Hub numeric user id (not username).
    await run(`
        UPDATE cliq."realm_members" m
        SET "member_id" = u."id"::text
        FROM "users" u
        WHERE m."member_type" = 'user'
          AND m."member_id" !~ '^[0-9]+$'
          AND lower(regexp_replace(m."member_id", '^@+', '')) = u."username"
          AND NOT EXISTS (
            SELECT 1 FROM cliq."realm_members" x
            WHERE x."realm_id" = m."realm_id"
              AND x."member_type" = 'user'
              AND x."member_id" = u."id"::text
          )
    `);
    await run(`
        DELETE FROM cliq."realm_members" m
        USING "users" u
        WHERE m."member_type" = 'user'
          AND m."member_id" !~ '^[0-9]+$'
          AND lower(regexp_replace(m."member_id", '^@+', '')) = u."username"
          AND EXISTS (
            SELECT 1 FROM cliq."realm_members" x
            WHERE x."realm_id" = m."realm_id"
              AND x."member_type" = 'user'
              AND x."member_id" = u."id"::text
          )
    `);

    // -- run_context support: external_id + context_labels on team_runs ------
    await run(`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "external_id" TEXT`);
    await run(`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "context_labels" JSONB`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "team_runs_external_id_uniq"
               ON cliq."team_runs" ("external_id") WHERE "external_id" IS NOT NULL`);

    // Realm team list: declarative set of teams auto-installed on realm daemons.
    await run(`ALTER TABLE cliq."realms"
               ADD COLUMN IF NOT EXISTS "team_list" JSONB NOT NULL DEFAULT '[]'::jsonb`);

    // Heartbeat team sync: hash for dedup, cleanup of legacy template rows.
    await run(`ALTER TABLE cliq."daemons" ADD COLUMN IF NOT EXISTS "teams_hash" TEXT`);

    // Claim NULL-daemon team rows that have runs referencing them:
    // assign them to the daemon that actually ran those runs.
    await run(`
        UPDATE cliq."teams" t
        SET "daemon_id" = sub."daemon_id"
        FROM (
            SELECT DISTINCT ON (r."team_id") r."team_id", r."daemon_id"
            FROM cliq."team_runs" r
            WHERE r."daemon_id" IS NOT NULL
              AND r."team_id" IN (
                SELECT id FROM cliq."teams" WHERE "daemon_id" IS NULL
              )
            ORDER BY r."team_id", r."started_at" DESC
        ) sub
        WHERE t."id" = sub."team_id"
          AND t."daemon_id" IS NULL
    `);

    // Delete remaining NULL-daemon rows that no longer have FK references.
    await run(`DELETE FROM cliq."teams" WHERE "daemon_id" IS NULL
               AND "id" NOT IN (SELECT "team_id" FROM cliq."team_runs")`);

    // Drop the legacy partial unique index (no longer needed).
    await run(`DROP INDEX IF EXISTS cliq."teams_scope_slug_legacy_uniq"`);

    // Phase 3 revised: keep daemon_id nullable.
    //
    // The prior migration tightened this to NOT NULL, but the app-level
    // team.controller / team.service intentionally treat daemon_id as
    // nullable — hub-catalog teams (created via /v1/control/teams/create)
    // and legacy clients both write null. Enforcing NOT NULL at the DB
    // meant fresh test schemas rejected those writes while long-lived
    // prod DBs (which had null rows and were skipped by the DO block)
    // continued to accept them. The result: green in prod, red in tests.
    // Rolling the constraint back matches app behaviour and is idempotent
    // on both new and old DBs.
    await run(`ALTER TABLE cliq."teams" ALTER COLUMN "daemon_id" DROP NOT NULL`);

    // Realm dispatch queue — exclusive (run/claim) + fan-out audit (install, …).
    await run(`CREATE TABLE IF NOT EXISTS cliq."realm_dispatch_queue" (
        "id" TEXT PRIMARY KEY,
        "realm_id" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
        "priority" INTEGER NOT NULL DEFAULT 0,
        "status" TEXT NOT NULL DEFAULT 'queued',
        "claimed_by" TEXT,
        "claimed_at" BIGINT,
        "run_id" TEXT,
        "results" JSONB,
        "submitted_by" TEXT NOT NULL,
        "submitted_at" BIGINT NOT NULL,
        "error" TEXT,
        "created_at" BIGINT NOT NULL,
        "updated_at" BIGINT NOT NULL
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "realm_dispatch_queue_realm_status_idx"
               ON cliq."realm_dispatch_queue" ("realm_id", "status", "priority", "created_at")
               WHERE "status" IN ('queued', 'offered', 'claimed', 'running', 'dispatching')`);

    // ── team_runs.realm_id ────────────────────────────────────────────
    //
    // Snapshot the realm at run-create time. `list_recent` now filters
    // by this column strictly (see run.service.ts) — no more daemon-hop
    // fallback that leaked runs across users when a daemon was shared
    // (see prod fossil 99a2f0f1). Backfill unambiguous rows once;
    // ambiguous or already-orphaned rows stay NULL and stay invisible
    // to realm listings (which is the correct behavior — we don't know
    // which realm they belonged to).
    await run(`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "realm_id" TEXT`);
    await run(`CREATE INDEX IF NOT EXISTS "team_runs_realm_id_idx"
               ON cliq."team_runs" ("realm_id") WHERE "realm_id" IS NOT NULL`);
    await run(`
        UPDATE cliq."team_runs" tr
        SET "realm_id" = sub."realm_id"
        FROM (
            SELECT rm."member_id" AS daemon_id, rm."realm_id"
            FROM cliq."realm_members" rm
            WHERE rm."member_type" = 'daemon'
              AND rm."member_id" IN (
                SELECT "member_id" FROM cliq."realm_members"
                WHERE "member_type" = 'daemon'
                GROUP BY "member_id"
                HAVING COUNT(DISTINCT "realm_id") = 1
              )
        ) sub
        WHERE tr."daemon_id" = sub."daemon_id"
          AND tr."realm_id" IS NULL
    `);

    // ── Backfill in_app_notifications + events with correct realm_id ─
    //
    // Legacy realm-leak (see team_runs.realm_id note above) tagged
    // hub events and in-app notification rows with the daemon's
    // *cached* realm rather than the run's actual realm. Result:
    // hundreds of rows point at the wrong realm (e.g. sapan's runs
    // showing up in krupali's realm). Now that team_runs.realm_id
    // is the source of truth, snap notifications + events back to it.
    //
    // Only touches rows where run_id links to a run with a known
    // realm_id and the current realm_id disagrees. Idempotent.
    await run(`
        UPDATE cliq."in_app_notifications" n
        SET "realm_id" = tr."realm_id"
        FROM cliq."team_runs" tr
        WHERE n."run_id" = tr."run_id"
          AND tr."realm_id" IS NOT NULL
          AND (n."realm_id" IS NULL OR n."realm_id" <> tr."realm_id")
    `);
    await run(`
        UPDATE cliq."events" e
        SET "realm_id" = tr."realm_id"
        FROM cliq."team_runs" tr
        WHERE e."run_id" = tr."run_id"
          AND tr."realm_id" IS NOT NULL
          AND (e."realm_id" IS NULL OR e."realm_id" <> tr."realm_id")
    `);

    // ── Realm agent settings ─────────────────────────────────────────
    await run(`
        CREATE TABLE IF NOT EXISTS cliq."realm_agent_settings" (
            "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            "realm_id" TEXT NOT NULL REFERENCES cliq."realms"("id") ON DELETE CASCADE,
            "agent_name" VARCHAR(128) NOT NULL,
            "setting_key" VARCHAR(128) NOT NULL,
            "setting_value" TEXT NOT NULL,
            "created_at" TIMESTAMPTZ DEFAULT now(),
            "updated_at" TIMESTAMPTZ DEFAULT now(),
            UNIQUE("realm_id", "agent_name", "setting_key")
        )
    `);
    await run(`CREATE INDEX IF NOT EXISTS "realm_agent_settings_realm_idx"
               ON cliq."realm_agent_settings" ("realm_id")`);

    // ── Agent catalog (Hub SoT for platform agents; packs + /v1/agents) ─
    // Hub must not use store `cliq.agents` as a catalog (daemon-local only).
    await run(`
        CREATE TABLE IF NOT EXISTS cliq."agent_catalog" (
            "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            "name" VARCHAR(128) UNIQUE NOT NULL,
            "version" VARCHAR(32),
            "description" TEXT,
            "agent_type" VARCHAR(32) NOT NULL DEFAULT 'exec',
            "manifest" JSONB NOT NULL,
            "bundle" TEXT,
            "deleted" BOOLEAN NOT NULL DEFAULT false,
            "deleted_at" BIGINT,
            "created_at" TIMESTAMPTZ DEFAULT now(),
            "updated_at" TIMESTAMPTZ DEFAULT now()
        )
    `);
    await run(`ALTER TABLE cliq."agent_catalog" ADD COLUMN IF NOT EXISTS "deleted" BOOLEAN NOT NULL DEFAULT false`);
    await run(`ALTER TABLE cliq."agent_catalog" ADD COLUMN IF NOT EXISTS "deleted_at" BIGINT`);
    await run(`CREATE INDEX IF NOT EXISTS "agent_catalog_deleted_idx" ON cliq."agent_catalog" ("deleted")`);

    // Workflow order column. Do NOT backfill from timestamps — those often
    // disagree with YAML order (retries / mirror quirks). create_many and
    // list_phases (manifest sort) own the real order.
    await run(`ALTER TABLE cliq."team_run_phases" ADD COLUMN IF NOT EXISTS "sequence" INTEGER NOT NULL DEFAULT 0`);

    // Soft-delete for realms — keep row for audit; filter deleted from APIs.
    await run(`ALTER TABLE cliq."realms" ADD COLUMN IF NOT EXISTS "deleted" BOOLEAN NOT NULL DEFAULT false`);
    await run(`ALTER TABLE cliq."realms" ADD COLUMN IF NOT EXISTS "deleted_at" BIGINT`);
    await run(`CREATE INDEX IF NOT EXISTS "realms_deleted_idx" ON cliq."realms" ("deleted")`);

    // v2 Notifications: tiered notification rules (replaces subscriptions).
    await run(`CREATE TABLE IF NOT EXISTS cliq."notification_rules" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "realm_id" TEXT,
        "team_slug" TEXT,
        "event" TEXT NOT NULL,
        "channel_id" TEXT NOT NULL,
        "priority" INTEGER NOT NULL DEFAULT 0,
        "created_at" BIGINT NOT NULL,
        "updated_at" BIGINT NOT NULL
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "notification_rules_realm_idx"
               ON cliq."notification_rules" ("realm_id")`);
    await run(`CREATE INDEX IF NOT EXISTS "notification_rules_event_idx"
               ON cliq."notification_rules" ("event")`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "notification_rules_tier_event_channel_uidx"
               ON cliq."notification_rules" ("realm_id", "team_slug", "event", "channel_id")
               NULLS NOT DISTINCT`);

    // Migrate existing subscriptions → rules (account bindings → global, realm bindings → realm).
    await run(`
        INSERT INTO cliq."notification_rules" ("realm_id", "team_slug", "event", "channel_id", "priority", "created_at", "updated_at")
        SELECT
            CASE WHEN s."realm_id" IS NOT NULL AND TRIM(s."realm_id") <> '' THEN s."realm_id" ELSE NULL END,
            NULL,
            s."event",
            s."channel_id",
            0,
            s."created_at",
            s."created_at"
        FROM cliq."notification_subscriptions" s
        WHERE NOT EXISTS (
            SELECT 1 FROM cliq."notification_rules" r
            WHERE r."realm_id" IS NOT DISTINCT FROM
                  CASE WHEN s."realm_id" IS NOT NULL AND TRIM(s."realm_id") <> '' THEN s."realm_id" ELSE NULL END
              AND r."team_slug" IS NULL
              AND r."event" = s."event"
              AND r."channel_id" = s."channel_id"
        )
    `);

    // v2 Notifications: custom event discovery table
    await run(`CREATE TABLE IF NOT EXISTS cliq."custom_events" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "event_type" TEXT NOT NULL,
        "source" TEXT NOT NULL DEFAULT 'observed',
        "realm_id" TEXT,
        "team_slug" TEXT,
        "label" TEXT,
        "created_at" BIGINT NOT NULL
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "custom_events_event_type_idx"
               ON cliq."custom_events" ("event_type")`);
    await run(`CREATE INDEX IF NOT EXISTS "custom_events_realm_id_idx"
               ON cliq."custom_events" ("realm_id")`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "custom_events_type_realm_team_uidx"
               ON cliq."custom_events" ("event_type", "realm_id", "team_slug")`);

    // Realm A2A settings (agent card + /send; mesh adapters store separately later)
    await run(`CREATE TABLE IF NOT EXISTS cliq."realm_a2a_settings" (
        "realm_id" TEXT PRIMARY KEY,
        "a2a_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
        "bearer_token_hash" TEXT,
        "bearer_token_prefix" TEXT,
        "created_at" BIGINT NOT NULL,
        "updated_at" BIGINT NOT NULL
    )`);
    await run(`ALTER TABLE cliq."realm_a2a_settings"
               ADD COLUMN IF NOT EXISTS "mesh_provider_mode" TEXT NOT NULL DEFAULT 'inherit'`);
    await run(`ALTER TABLE cliq."realm_a2a_settings"
               ADD COLUMN IF NOT EXISTS "active_provider_id" TEXT`);
    await run(`ALTER TABLE cliq."realm_a2a_settings"
               ADD COLUMN IF NOT EXISTS "providers" JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await run(`ALTER TABLE cliq."realm_a2a_settings"
               ADD COLUMN IF NOT EXISTS "mesh_status" JSONB`);

    await run(`CREATE TABLE IF NOT EXISTS cliq."account_mesh_settings" (
        "user_id" TEXT PRIMARY KEY,
        "active_provider_id" TEXT,
        "providers" JSONB NOT NULL DEFAULT '{}'::jsonb,
        "auto_enable_a2a_on_realm_create" BOOLEAN NOT NULL DEFAULT FALSE,
        "created_at" BIGINT NOT NULL,
        "updated_at" BIGINT NOT NULL
    )`);

    // Realm owns A2A surface + org linkage (mesh defaults live on public.orgs).
    await run(`ALTER TABLE cliq."realms"
               ADD COLUMN IF NOT EXISTS "org_id" UUID`);
    await run(`ALTER TABLE cliq."realms"
               ADD COLUMN IF NOT EXISTS "a2a_enabled" BOOLEAN NOT NULL DEFAULT FALSE`);
    await run(`ALTER TABLE cliq."realms"
               ADD COLUMN IF NOT EXISTS "a2a_bearer_token_hash" TEXT`);
    await run(`ALTER TABLE cliq."realms"
               ADD COLUMN IF NOT EXISTS "a2a_bearer_token_prefix" TEXT`);
    await run(`ALTER TABLE cliq."realms"
               ADD COLUMN IF NOT EXISTS "mesh_provider_mode" TEXT NOT NULL DEFAULT 'inherit'`);
    await run(`ALTER TABLE cliq."realms"
               ADD COLUMN IF NOT EXISTS "mesh_active_provider_id" TEXT`);
    await run(`ALTER TABLE cliq."realms"
               ADD COLUMN IF NOT EXISTS "mesh_providers" JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await run(`ALTER TABLE cliq."realms"
               ADD COLUMN IF NOT EXISTS "mesh_status" JSONB`);
    await run(`CREATE INDEX IF NOT EXISTS "realms_org_id_idx"
               ON cliq."realms" ("org_id")`);

    // Copy legacy side-table rows onto realms (idempotent).
    await run(`
        UPDATE cliq."realms" r
        SET
            a2a_enabled = COALESCE(s.a2a_enabled, r.a2a_enabled),
            a2a_bearer_token_hash = COALESCE(s.bearer_token_hash, r.a2a_bearer_token_hash),
            a2a_bearer_token_prefix = COALESCE(s.bearer_token_prefix, r.a2a_bearer_token_prefix),
            mesh_provider_mode = COALESCE(s.mesh_provider_mode, r.mesh_provider_mode),
            mesh_active_provider_id = COALESCE(s.active_provider_id, r.mesh_active_provider_id),
            mesh_providers = COALESCE(s.providers, r.mesh_providers),
            mesh_status = COALESCE(s.mesh_status, r.mesh_status)
        FROM cliq."realm_a2a_settings" s
        WHERE s.realm_id = r.id
    `);

    // v2 Notifications: multi-destination channels. Backfill existing
    // single-provider channels into the new destinations JSONB array.
    await run(`ALTER TABLE cliq."notification_channels"
               ADD COLUMN IF NOT EXISTS "destinations" TEXT NOT NULL DEFAULT '[]'`);
    await run(`
        UPDATE cliq."notification_channels"
        SET "destinations" = CASE
            WHEN "provider" = 'slack' THEN
                jsonb_build_array(jsonb_build_object('type', 'slack', 'webhook_url',
                    (config::jsonb)->>'webhook_url'))::text
            WHEN "provider" = 'email' THEN
                jsonb_build_array(jsonb_build_object('type', 'email', 'address',
                    (config::jsonb)->>'to')
                    || CASE WHEN (config::jsonb)->>'cc' IS NOT NULL
                        THEN jsonb_build_object('cc', (config::jsonb)->>'cc')
                        ELSE '{}'::jsonb END
                    || CASE WHEN (config::jsonb)->>'bcc' IS NOT NULL
                        THEN jsonb_build_object('bcc', (config::jsonb)->>'bcc')
                        ELSE '{}'::jsonb END
                )::text
            WHEN "provider" = 'webhook' THEN
                jsonb_build_array(jsonb_build_object('type', 'webhook', 'url',
                    (config::jsonb)->>'url')
                    || CASE WHEN (config::jsonb)->'headers' IS NOT NULL
                        THEN jsonb_build_object('headers', (config::jsonb)->'headers')
                        ELSE '{}'::jsonb END
                )::text
            WHEN "provider" = 'cliqhub' THEN
                '[{"type":"cliqhub"}]'
            ELSE '[]'
        END
        WHERE "destinations" = '[]'
    `);

    // ── Org-as-account: org_id on channels and rules ────────────────
    await run(`ALTER TABLE cliq."notification_channels"
               ADD COLUMN IF NOT EXISTS "org_id" UUID`);
    await run(`CREATE INDEX IF NOT EXISTS "notification_channels_org_id_idx"
               ON cliq."notification_channels" ("org_id")`);

    await run(`ALTER TABLE cliq."notification_rules"
               ADD COLUMN IF NOT EXISTS "org_id" UUID`);
    await run(`CREATE INDEX IF NOT EXISTS "notification_rules_org_id_idx"
               ON cliq."notification_rules" ("org_id")`);

    // ── team_runs.lease_expires_at (Hub action lease) ─────────────────
    // See DESIGN-control-message-reliability Phase 3.
    await run(`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "lease_expires_at" BIGINT`);
    await run(`CREATE INDEX IF NOT EXISTS "team_runs_lease_expires_at_idx"
               ON cliq."team_runs" ("lease_expires_at")
               WHERE "lease_expires_at" IS NOT NULL
                 AND "state" IN ('running', 'awaiting_input')`);

    // ── Inbound dedup: idempotent daemon → Hub message processing ───
    // See DESIGN-outbox-sync-protocol Phase 2.
    await run(`CREATE TABLE IF NOT EXISTS cliq."inbound_dedup" (
        "tx_id"       TEXT    PRIMARY KEY,
        "endpoint"    TEXT    NOT NULL,
        "status_code" INTEGER NOT NULL,
        "response"    JSONB   NOT NULL DEFAULT '{}'::jsonb,
        "created_at"  BIGINT  NOT NULL
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "inbound_dedup_created_at_idx"
               ON cliq."inbound_dedup" ("created_at")`);

    // ── Command outbox: Hub → daemon durable delivery ───────────────
    // See DESIGN-outbox-sync-protocol Phase 4 (table created early so
    // /v1/daemons/ack_command has something to reference).
    await run(`CREATE TABLE IF NOT EXISTS cliq."command_outbox" (
        "tx_id"       TEXT    PRIMARY KEY,
        "daemon_id"   TEXT    NOT NULL,
        "endpoint"    TEXT    NOT NULL,
        "payload"     JSONB   NOT NULL DEFAULT '{}'::jsonb,
        "attempts"    INTEGER NOT NULL DEFAULT 0,
        "max_attempts" INTEGER NOT NULL DEFAULT 5,
        "created_at"  BIGINT  NOT NULL,
        "delivered_at" BIGINT,
        "acked_at"    BIGINT,
        "ack_status"  TEXT,
        "ack_data"    JSONB,
        "ack_error"   TEXT,
        "error"       TEXT
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "command_outbox_pending_idx"
               ON cliq."command_outbox" ("daemon_id", "created_at")
               WHERE "delivered_at" IS NULL`);

    // ── run_spans (OTEL observability, Phase 1) ───────────────────────
    // Every cliq run is one W3C trace; child spans are phases/agents.
    // Ingested by daemons through POST /v1/runs/report_telemetry (kind: traces) and
    // surfaced on the run detail Timeline tab. See DESIGN-otel-observability.
    await run(`CREATE TABLE IF NOT EXISTS cliq."run_spans" (
        "span_id" TEXT PRIMARY KEY,
        "trace_id" TEXT NOT NULL,
        "parent_span_id" TEXT,
        "run_id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "status_code" TEXT NOT NULL DEFAULT 'UNSET',
        "status_message" TEXT,
        "start_unix_nano" BIGINT NOT NULL,
        "end_unix_nano" BIGINT NOT NULL,
        "attributes" JSONB NOT NULL DEFAULT '{}'::jsonb,
        "events" JSONB NOT NULL DEFAULT '[]'::jsonb,
        "daemon_id" TEXT,
        "realm_id" TEXT,
        "created_at" BIGINT NOT NULL
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "run_spans_run_start_idx"
               ON cliq."run_spans" ("run_id", "start_unix_nano")`);
    await run(`CREATE INDEX IF NOT EXISTS "run_spans_trace_idx"
               ON cliq."run_spans" ("trace_id")`);
    await run(`CREATE INDEX IF NOT EXISTS "run_spans_realm_start_idx"
               ON cliq."run_spans" ("realm_id", "start_unix_nano")
               WHERE "realm_id" IS NOT NULL`);
    // Fleet-wide telemetry rollup on POST /v1/runs/get_telemetry (kind: summary)
    // filters `WHERE name = 'run.execute' AND end_unix_nano BETWEEN ...`.
    // Without this partial index the tile endpoint sequentially scans
    // every span row for every dashboard poll.
    await run(`CREATE INDEX IF NOT EXISTS "run_spans_root_end_idx"
               ON cliq."run_spans" ("end_unix_nano")
               WHERE "name" = 'run.execute' AND "parent_span_id" IS NULL`);

    // ── team_runs.force_terminated_at (Hub-side force cancel) ──────────
    // Non-null when a Hub-authorised user gave up waiting on the
    // daemon and marked the run cancelled from the Hub side (usually
    // because the daemon is unreachable or wedged). Consumed by:
    //   • the state reconciler — non-terminal reports from a reconnecting
    //     daemon are ignored while this is set, preventing a force
    //     cancel from being silently un-terminated when the daemon
    //     eventually catches up.
    //   • the run detail banner — flips from "Cancel pending" to
    //     "Force cancelled by @X at T".
    // Nullable BIGINT (ms since epoch) so we can also store WHO / WHY
    // in adjacent columns without a follow-up migration.
    await run(`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "force_terminated_at" BIGINT`);
    await run(`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "force_terminated_by_user_id" TEXT`);
    await run(`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "force_terminated_reason" TEXT`);

    // ── model_pricing (observability Phase 1d) ───────────────────────
    // Central table for LLM token → cost resolution. Hub calculates
    // cost_usd from daemon-reported tokens using these rates.
    // Version-controlled seed: seed/model_pricing.json.
    await run(`CREATE TABLE IF NOT EXISTS cliq."model_pricing" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "provider" TEXT NOT NULL,
        "model" TEXT NOT NULL,
        "input_per_1m" NUMERIC(12, 6) NOT NULL,
        "output_per_1m" NUMERIC(12, 6) NOT NULL,
        "effective_from" DATE NOT NULL DEFAULT CURRENT_DATE,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE ("provider", "model", "effective_from")
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "idx_model_pricing_lookup"
               ON cliq."model_pricing" ("provider", "model", "effective_from" DESC)`);

    // Usage snapshot JSONB columns for durable run/phase usage data.
    await run(`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "usage_snapshot" JSONB`);
    await run(`ALTER TABLE cliq."team_run_phases" ADD COLUMN IF NOT EXISTS "usage_snapshot" JSONB`);

    // ── previous_attempts (phase history across resumes) ─────────────
    // When a phase is reset on resume, the current attempt's timing +
    // exit code + error is snapshotted here so the run detail chart can
    // show the full history instead of only the latest attempt. Array
    // of { attempt, dispatched_at, started_at, completed_at, exit_code,
    // error, status }. Newest attempt at the tail.
    await run(`ALTER TABLE cliq."team_run_phases" ADD COLUMN IF NOT EXISTS "previous_attempts" JSONB DEFAULT '[]'::jsonb`);

    // ── team_run_events (observability Phase 2c) ─────────────────────
    // Stores streaming events ingested from daemons. Hub-side storage
    // for SSE fan-out and completed-run replay when daemon is offline.
    await run(`CREATE TABLE IF NOT EXISTS cliq."team_run_events" (
        "id" BIGSERIAL PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "event_type" TEXT NOT NULL,
        "phase" TEXT,
        "agent" TEXT,
        "payload" JSONB,
        "daemon_id" TEXT,
        "realm_id" TEXT,
        "timestamp" BIGINT NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "idx_team_run_events_run_id"
               ON cliq."team_run_events" ("run_id", "id")`);
    await run(`CREATE INDEX IF NOT EXISTS "idx_team_run_events_created_at"
               ON cliq."team_run_events" ("created_at")`);

    // Legacy shape has `created_at BIGINT NOT NULL` with no default. The
    // current INSERT in RunService.ingest_events omits the column, expecting
    // the DB to fill it. Add a DEFAULT so pre-existing legacy tables don't
    // reject the insert with a not-null violation. Idempotent no-op on the
    // fresh shape (TIMESTAMPTZ DEFAULT NOW()) — the DO block only fires
    // when the column is bigint.
    await run(`DO $$
        DECLARE
            _type text;
        BEGIN
            SELECT data_type INTO _type FROM information_schema.columns
                WHERE table_schema = 'cliq' AND table_name = 'team_run_events'
                    AND column_name = 'created_at';
            IF _type = 'bigint' THEN
                EXECUTE 'ALTER TABLE cliq."team_run_events"
                             ALTER COLUMN "created_at"
                             SET DEFAULT (EXTRACT(EPOCH FROM NOW())*1000)::BIGINT';
            END IF;
        END $$`);


    // ── webhook_deliveries audit table (JIRA plugin slice 1.4) ───────
    // One row per WebhookDeliverer.deliver() attempt (success or fail).
    // Powers the "recent deliveries" table on the SPA and gives operators
    // a receipts trail for debugging Forge / third-party integrations.
    // Retention is handled by a nightly sweep (see webhook_delivery.service).
    await run(`CREATE TABLE IF NOT EXISTS cliq."webhook_deliveries" (
        "id"           TEXT    PRIMARY KEY,
        "channel_id"   TEXT    NOT NULL,
        "event_type"   TEXT    NOT NULL,
        "url"          TEXT    NOT NULL,
        "status_code"  INTEGER,
        "response_ms"  INTEGER,
        "attempted_at" BIGINT  NOT NULL,
        "error"        TEXT
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "webhook_deliveries_channel_attempted_idx"
               ON cliq."webhook_deliveries" ("channel_id", "attempted_at" DESC)`);
    await run(`CREATE INDEX IF NOT EXISTS "webhook_deliveries_attempted_at_idx"
               ON cliq."webhook_deliveries" ("attempted_at")`);

    // ── notification_channels.secret (JIRA plugin slice 1.2) ─────────
    // Dedicated nullable column for HMAC shared secrets on webhook
    // channels. Lets `get_channel` mask a single field cleanly rather
    // than parsing config JSON, and gives rotate a one-UPDATE surface.
    // Existing channels keep their config.secret (if any) — the
    // deliverer prefers the column but falls back to config.secret so
    // no consumer breaks. No backfill in this slice; new writes populate
    // the column, legacy rows keep working through the fallback path.
    await run(`ALTER TABLE cliq."notification_channels"
               ADD COLUMN IF NOT EXISTS "secret" TEXT`);

    // ── Backfill built-in teams into existing realm team_lists ────────
    // Realms created before the seed_builtin_teams hook may have empty
    // team_lists. Idempotent: only touches realms that don't already
    // include @cliq/hello-world.
    await run(`UPDATE cliq."realms"
               SET "team_list" = "team_list" || '[{"scope":"cliq","slug":"hello-world"}]'::jsonb,
                   "updated_at" = ${Date.now()}
               WHERE "deleted" = false
                 AND NOT "team_list" @> '[{"scope":"cliq","slug":"hello-world"}]'::jsonb`);

    // ── team_runs.state_lost_at (daemon lost the run's local state) ───
    // Set when a Hub-dispatched command against this run comes back
    // from the daemon with `run_not_found` — meaning the daemon is
    // reachable but its local SQLite has no record of the run (its
    // ephemeral pod storage was wiped on a restart). Once set, the
    // UI stops offering Resume and steers the user to Run again with
    // the same inputs. Null for healthy runs; ms-epoch on detection.
    await run(`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "state_lost_at" BIGINT`);

    // ── Repair required flags forced by earlier template-scan backfill ─
    // Prior boot migrated every {{inputs.X}} ref to required:true, wiping
    // author required:false. Repair from manifest_yaml; keep inventing
    // undeclared refs as required only.
    await repair_capability_required_flags(sq);

    // ── HUG Phase 1: review_notifications + review policy ────────────

    /** Add policy JSONB column to reviews (stores reviewer group definitions). */
    await run(`ALTER TABLE cliq."reviews"
        ADD COLUMN IF NOT EXISTS "policy" JSONB NOT NULL DEFAULT '{"groups":[]}'`);

    /** Per-destination notification rows — unit of policy evaluation and audit. */
    await run(`CREATE TABLE IF NOT EXISTS cliq."review_notifications" (
        "id"              TEXT PRIMARY KEY,
        "review_id"       TEXT NOT NULL REFERENCES cliq."reviews"("id") ON DELETE CASCADE,
        "group_idx"       SMALLINT NOT NULL,
        "channel_target"  TEXT NOT NULL,
        "channel_id"      TEXT,
        "user_id"         UUID,
        "responded_by"    UUID,
        "responded_at"    TIMESTAMPTZ,
        "action"          TEXT,
        "comment"         TEXT,
        "created_at"      TIMESTAMPTZ DEFAULT now()
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "idx_review_notifications_review"
        ON cliq."review_notifications" ("review_id")`);
    await run(`CREATE INDEX IF NOT EXISTS "idx_review_notifications_user"
        ON cliq."review_notifications" ("user_id") WHERE "user_id" IS NOT NULL`);

    /** Add user_id to in_app_notifications for per-user targeting. */
    await run(`ALTER TABLE cliq."in_app_notifications"
        ADD COLUMN IF NOT EXISTS "user_id" UUID`);
    await run(`CREATE INDEX IF NOT EXISTS "idx_in_app_notifications_user"
        ON cliq."in_app_notifications" ("user_id") WHERE "user_id" IS NOT NULL`);

    /** Add user_id column to notification_channels (must precede backfill). */
    await run(`ALTER TABLE cliq."notification_channels"
        ADD COLUMN IF NOT EXISTS "user_id" UUID`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "notification_channels_user_org_uidx"
        ON cliq."notification_channels" ("user_id", "org_id")
        WHERE "user_id" IS NOT NULL`);

    /**
     * Replace global name uniqueness with org-scoped uniqueness.
     * Must happen BEFORE backfill — the old index blocks multiple
     * personal channels with the same username across orgs.
     */
    await run(`DROP INDEX IF EXISTS cliq."notification_channels_account_name_uidx"`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "notification_channels_org_name_uidx"
        ON cliq."notification_channels" ("org_id", "name")
        WHERE "realm_id" IS NULL`);

    // ── HUG Phase 8: deprecate realm_id on reviews ──────────────────

    /**
     * Drop the realm-status index — realm_id is no longer used for
     * queries. The column itself stays (old rows still carry the value)
     * but new reviews may leave it NULL. Column drop happens in a
     * follow-up migration once all callers are confirmed clean.
     */
    await run(`DROP INDEX IF EXISTS cliq."reviews_realm_status_idx"`);

    // ── Channel destinations normalization ───────────────────────────

    /** Create the channel_destinations table — one row per destination. */
    await run(`CREATE TABLE IF NOT EXISTS cliq."channel_destinations" (
        "id"          TEXT PRIMARY KEY,
        "channel_id"  TEXT NOT NULL REFERENCES cliq."notification_channels"("id") ON DELETE CASCADE,
        "type"        TEXT NOT NULL,
        "config"      JSONB NOT NULL DEFAULT '{}',
        "created_at"  BIGINT NOT NULL
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "channel_destinations_channel_id_idx"
        ON cliq."channel_destinations" ("channel_id")`);
    await run(`CREATE INDEX IF NOT EXISTS "channel_destinations_type_idx"
        ON cliq."channel_destinations" ("type")`);

    /** Drop legacy columns — destinations live in channel_destinations rows. */
    await run(`ALTER TABLE cliq."notification_channels" DROP COLUMN IF EXISTS "destinations"`);
    await run(`ALTER TABLE cliq."notification_channels" DROP COLUMN IF EXISTS "config"`);
    await run(`ALTER TABLE cliq."notification_channels" DROP COLUMN IF EXISTS "provider"`);

    /** Coerce legacy integer user_id FKs to UUID (Hub PK migration). */
    await coerce_user_id_columns_to_uuid(sq);

    /** Ensure every org member has a personal notification channel. */
    await backfill_per_user_channels(sq);

    // ── In-app notification: review_id column for HUG queries ────────

    await run(`ALTER TABLE cliq."in_app_notifications"
        ADD COLUMN IF NOT EXISTS "review_id" TEXT`);
    await run(`CREATE INDEX IF NOT EXISTS "in_app_notifications_review_id_idx"
        ON cliq."in_app_notifications" ("review_id")
        WHERE "review_id" IS NOT NULL`);

    /** Backfill review_id from payload_json for existing hug.* notifications. */
    await run(`
        UPDATE cliq."in_app_notifications"
        SET "review_id" = "payload_json"::jsonb->>'review_id'
        WHERE "event" LIKE 'hug.%'
          AND "review_id" IS NULL
          AND "payload_json"::jsonb->>'review_id' IS NOT NULL
    `);

    // ── Reviews: last_reminded_at column ─────────────────────────────

    await run(`ALTER TABLE cliq."reviews"
        ADD COLUMN IF NOT EXISTS "last_reminded_at" TIMESTAMPTZ`);

    // ── Realms: org_id NOT NULL ───────────────────────────────────────
    // All existing rows already have org_id set. Enforce going forward.

    await run(`ALTER TABLE cliq."realms"
        ALTER COLUMN "org_id" SET NOT NULL`);

    // ── Reviews: denormalized org_id for org-scoped listing ──────────

    await run(`ALTER TABLE cliq."reviews"
        ADD COLUMN IF NOT EXISTS "org_id" UUID`);

    // Backfill org_id from the review's realm.
    await run(`UPDATE cliq."reviews" r
        SET "org_id" = rm."org_id"
        FROM cliq."realms" rm
        WHERE r."realm_id" = rm."id"
          AND r."org_id" IS NULL
          AND rm."org_id" IS NOT NULL`);

    // ── In-app notifications: org_id for org-scoped inbox ───────────

    await run(`ALTER TABLE cliq."in_app_notifications"
        ADD COLUMN IF NOT EXISTS "org_id" UUID`);
    await run(`CREATE INDEX IF NOT EXISTS "in_app_notifications_org_id_idx"
        ON cliq."in_app_notifications" ("org_id")`);

    // Backfill org_id from the notification's realm.
    await run(`UPDATE cliq."in_app_notifications" n
        SET "org_id" = rm."org_id"
        FROM cliq."realms" rm
        WHERE n."realm_id" = rm."id"
          AND n."org_id" IS NULL
          AND rm."org_id" IS NOT NULL`);

    // ── Runs: denormalized org_id for org-scoped listing ─────────────

    await run(`ALTER TABLE cliq."team_runs"
        ADD COLUMN IF NOT EXISTS "org_id" UUID`);

    // Backfill org_id from the run's realm.
    await run(`UPDATE cliq."team_runs" tr
        SET "org_id" = rm."org_id"
        FROM cliq."realms" rm
        WHERE tr."realm_id" = rm."id"
          AND tr."org_id" IS NULL
          AND rm."org_id" IS NOT NULL`);

    // ── Reviews: Hub-owned remind interval (SLICE reviews flat hard-cut) ─
    await run(`ALTER TABLE cliq."reviews"
        ADD COLUMN IF NOT EXISTS "remind_every_minutes" INTEGER`);

    // Org-scoped realm slug uniqueness (active rows only).
    // Base schema, not a data backfill.
    await run(`ALTER TABLE cliq."realms"
        DROP CONSTRAINT IF EXISTS "realms_slug_key"`);
    await run(`DROP INDEX IF EXISTS cliq."realms_slug_key"`);
    await run(`DROP INDEX IF EXISTS cliq."realms_slug_unique"`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "realms_org_id_slug_unique"
        ON cliq."realms" ("org_id", "slug")
        WHERE "deleted" = false`);

    // ── HUG Chat Phase 1: review_messages + claim columns ───────────

    /** Add sender_id to the existing review_chat_messages table. */
    await run(`ALTER TABLE cliq."review_chat_messages"
        ADD COLUMN IF NOT EXISTS "sender_id" UUID`);

    /** Add claim columns to reviews for single-reviewer locking. */
    await run(`ALTER TABLE cliq."reviews"
        ADD COLUMN IF NOT EXISTS "claimed_by" UUID`);
    await run(`ALTER TABLE cliq."reviews"
        ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMPTZ`);

    // ── team_runs.team_version_id (stamp workflow version at create) ──
    // Nullable: local-only teams without public.team_versions leave null
    // and seed from cliq.teams.manifest instead. SPA uses this with
    // teams/get_phases so older runs keep the workflow they started on.
    await run(`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "team_version_id" TEXT`);
    await run(`CREATE INDEX IF NOT EXISTS "team_runs_team_version_id_idx"
               ON cliq."team_runs" ("team_version_id")
               WHERE "team_version_id" IS NOT NULL`);

    // ── Agent catalog: custom agent support (Phase 3) ────────────────
    //
    // Add org_id (nullable UUID — NULL = system/built-in agent) and
    // is_system (boolean flag). Drop the bundle column (built-ins ship
    // in the SEA binary; Hub does not distribute agent binaries).
    // Replace the legacy name-only unique with a composite functional
    // index so the same agent name can exist in different orgs.
    // Backfill: existing rows (org_id IS NULL) are system agents.

    await run(`ALTER TABLE cliq."agent_catalog" ADD COLUMN IF NOT EXISTS "org_id" UUID`);
    await run(`ALTER TABLE cliq."agent_catalog" ADD COLUMN IF NOT EXISTS "is_system" BOOLEAN NOT NULL DEFAULT false`);
    await run(`ALTER TABLE cliq."agent_catalog" DROP COLUMN IF EXISTS "bundle"`);

    // Drop the legacy unique constraint on name alone.
    await run(`ALTER TABLE cliq."agent_catalog" DROP CONSTRAINT IF EXISTS "agent_catalog_name_key"`);
    await run(`DROP INDEX IF EXISTS cliq."agent_catalog_name_key"`);

    // Composite unique: (org_id, name, version) with NULL-safe COALESCE.
    // System agents share the zero UUID sentinel; custom agents key on real org_id.
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "agent_catalog_org_name_version_uidx"
               ON cliq."agent_catalog" (
                   COALESCE("org_id", '00000000-0000-0000-0000-000000000000'),
                   "name",
                   COALESCE("version", '__none__')
               )`);

    // Backfill: mark all existing hub-seeded rows as system agents.
    await run(`UPDATE cliq."agent_catalog" SET is_system = true
               WHERE org_id IS NULL AND is_system = false`);

    await run(`CREATE INDEX IF NOT EXISTS "agent_catalog_org_id_idx"
               ON cliq."agent_catalog" ("org_id") WHERE "org_id" IS NOT NULL`);
    await run(`CREATE INDEX IF NOT EXISTS "agent_catalog_is_system_idx"
               ON cliq."agent_catalog" ("is_system")`);
}

/**
 * Ensure every org member has a personal notification channel.
 *
 * Inserts into notification_channels (new schema — no provider/config/
 * destinations columns) and creates a default cliqhub destination row
 * in channel_destinations. Idempotent via (user_id, org_id) unique index.
 */

/**
 * Hub UUID PK migration: widen integer user_id columns to UUID.
 * Idempotent — no-op when the column is already uuid.
 */
async function coerce_user_id_columns_to_uuid(sq: Sequelize): Promise<void> {
    const targets: Array<{ schema: string; table: string; column: string }> = [
        { schema: 'cliq', table: 'notification_channels', column: 'user_id' },
        { schema: 'cliq', table: 'in_app_notifications', column: 'user_id' },
        { schema: 'cliq', table: 'review_notifications', column: 'user_id' },
        { schema: 'cliq', table: 'review_notifications', column: 'responded_by' },
        { schema: 'cliq', table: 'review_chat_messages', column: 'sender_id' },
        { schema: 'cliq', table: 'reviews', column: 'claimed_by' },
    ];
    for (const tgt of targets) {
        try {
            await sq.query(`
                DO $$
                BEGIN
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = '${tgt.schema}'
                          AND table_name = '${tgt.table}'
                          AND column_name = '${tgt.column}'
                          AND data_type IN ('integer', 'bigint')
                    ) THEN
                        EXECUTE format(
                            'ALTER TABLE %I.%I ALTER COLUMN %I TYPE UUID USING (
                                CASE WHEN %I IS NULL THEN NULL
                                ELSE (
                                    ''00000000-0000-4000-8000-'' || lpad(to_hex(%I::bigint), 12, ''0'')
                                )::uuid END
                            )',
                            '${tgt.schema}', '${tgt.table}', '${tgt.column}', '${tgt.column}', '${tgt.column}'
                        );
                    END IF;
                END $$;
            `);
        } catch (err) {
            console.error(`[coerce_user_id_columns_to_uuid] ${tgt.schema}.${tgt.table}.${tgt.column} failed:`, err);
        }
    }
}

async function backfill_per_user_channels(sq: Sequelize): Promise<void> {
    try {
        /** Insert missing channel rows. */
        await sq.query(`
            INSERT INTO cliq."notification_channels"
                ("id", "realm_id", "org_id", "user_id", "name",
                 "enabled", "created_at", "updated_at")
            SELECT
                gen_random_uuid()::TEXT,
                NULL,
                om."org_id",
                om."user_id",
                u."username",
                1,
                EXTRACT(EPOCH FROM NOW()) * 1000,
                EXTRACT(EPOCH FROM NOW()) * 1000
            FROM public."org_members" om
            JOIN public."users" u ON u."id" = om."user_id"
            WHERE NOT EXISTS (
                SELECT 1 FROM cliq."notification_channels" nc
                WHERE nc."user_id" = om."user_id" AND nc."org_id" = om."org_id"
            )
        `);

        /** Insert default cliqhub destination for any channel missing one. */
        await sq.query(`
            INSERT INTO cliq."channel_destinations"
                ("id", "channel_id", "type", "config", "created_at")
            SELECT
                gen_random_uuid()::TEXT,
                nc."id",
                'cliqhub',
                '{}',
                EXTRACT(EPOCH FROM NOW()) * 1000
            FROM cliq."notification_channels" nc
            WHERE nc."user_id" IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM cliq."channel_destinations" cd
                WHERE cd."channel_id" = nc."id"
              )
        `);
    } catch (err) {
        console.error('[backfill_per_user_channels] failed:', err);
    }
}

/**
 * Repair capability_json.inputs[].required after the old template-scan
 * backfill forced every `{{inputs.X}}` ref to required:true.
 *
 * For each team_version:
 *   1. Restore `required: false` from manifest_yaml when the author set it.
 *   2. Invent undeclared workflow refs as required:true (UI parity with
 *      daemon when there is no team declaration to opt out).
 *
 * Idempotent — only writes when capability_json changes.
 */
async function repair_capability_required_flags(sq: Sequelize): Promise<void> {
    const TEMPLATE_RE = /\{\{inputs\.([^}]+)\}\}/g;

    let rows: Array<{
        id: string;
        workflow_json: string;
        capability_json: string;
        manifest_yaml: string;
    }>;
    try {
        const [result] = await sq.query(
            `SELECT id, workflow_json, capability_json, manifest_yaml
               FROM public.team_versions`,
        );
        rows = result as Array<{
            id: string;
            workflow_json: string;
            capability_json: string;
            manifest_yaml: string;
        }>;
    } catch {
        return;
    }

    for (const row of rows) {
        let capability: {
            inputs?: Array<{ name: string; required?: boolean; [k: string]: unknown }>;
            [k: string]: unknown;
        };
        try {
            capability = JSON.parse(row.capability_json || '{}');
        } catch {
            capability = {};
        }

        const by_name = new Map(
            (capability.inputs ?? []).map((inp) => [inp.name, { ...inp }]),
        );

        /** Author intent from team.yml — wins over prior forced required:true. */
        let changed = false;
        try {
            const doc = yaml.load(row.manifest_yaml || '') as {
                inputs?: Array<{ name?: unknown; required?: unknown }>;
            } | null;
            if (doc && Array.isArray(doc.inputs)) {
                for (const raw of doc.inputs) {
                    if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) continue;
                    const name = raw.name.trim();
                    if (raw.required !== false) continue;
                    const existing = by_name.get(name);
                    if (existing) {
                        if (existing.required !== false) {
                            existing.required = false;
                            changed = true;
                        }
                    } else {
                        by_name.set(name, { name, required: false });
                        changed = true;
                    }
                }
            }
        } catch {
            /* corrupt manifest — skip restore for this row */
        }

        /** Undeclared template refs → invent as required (daemon-aligned). */
        try {
            const workflow = JSON.parse(row.workflow_json || '{}') as {
                phases?: Array<{ commands?: Array<{ run?: string }> }>;
                support?: Array<{ commands?: Array<{ run?: string }> }>;
            };
            const all_phases = [
                ...(workflow.phases ?? []),
                ...(workflow.support ?? []),
            ];
            for (const phase of all_phases) {
                if (!Array.isArray(phase?.commands)) continue;
                for (const cmd of phase.commands) {
                    if (typeof cmd?.run !== 'string') continue;
                    for (const m of cmd.run.matchAll(TEMPLATE_RE)) {
                        const name = m[1].trim();
                        if (!name || by_name.has(name)) continue;
                        by_name.set(name, { name, required: true });
                        changed = true;
                    }
                }
            }
        } catch {
            /* corrupt workflow — skip invent */
        }

        if (!changed) continue;

        capability.inputs = [...by_name.values()];
        try {
            await sq.query(
                `UPDATE public.team_versions SET capability_json = $1 WHERE id = $2`,
                { bind: [JSON.stringify(capability), row.id] },
            );
        } catch {
            /* best-effort per row */
        }
    }
}



