/**
 * Idempotent schema migrations for Hub-mounted control plane (ported from Core BFF).
 * Each statement uses IF NOT EXISTS / safe checks so it can re-run.
 */

import { get_logger } from '../../lib/log.js';
import { QueryTypes, type Sequelize } from 'sequelize';
import yaml from 'js-yaml';
import { SemVer } from '../../lib/semver.js';

const _mig_log = get_logger('migrations');

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

    // Drop orphan account-global channels: no realm, no org and no user. Org
    // channels (the seeded Email / In-app ones included) and personal channels
    // also have no realm and must survive every boot. `org_id` and `user_id`
    // are read through to_jsonb because they are added further down, so on a
    // database without them every realm-less channel is an orphan.
    const orphan_channel = `(c."realm_id" IS NULL OR TRIM(c."realm_id") = '')
                 AND to_jsonb(c) ->> 'org_id' IS NULL
                 AND to_jsonb(c) ->> 'user_id' IS NULL`;
    await run(`DELETE FROM cliq."notification_subscriptions" s
               WHERE s."channel_id" IN (
                 SELECT c."id" FROM cliq."notification_channels" c
                 WHERE ${orphan_channel}
               )`);
    await run(`DELETE FROM cliq."notification_channels" c
               WHERE ${orphan_channel}`);

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

    // -- run start options: reviewers per human phase, notification channel override --
    await run(`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "reviewers" TEXT`);
    await run(`ALTER TABLE cliq."team_runs" ADD COLUMN IF NOT EXISTS "notify_channels" TEXT`);

    // Realm team list: declarative set of teams auto-installed on realm daemons.
    await run(`ALTER TABLE cliq."realms"
               ADD COLUMN IF NOT EXISTS "team_list" JSONB NOT NULL DEFAULT '[]'::jsonb`);

    // Heartbeat team sync: hash for dedup, cleanup of legacy template rows.
    await run(`ALTER TABLE cliq."daemons" ADD COLUMN IF NOT EXISTS "teams_hash" TEXT`);

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
    await run(`ALTER TABLE cliq."realms" ADD COLUMN IF NOT EXISTS "description" TEXT`);
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
    // Only on schemas that still have the legacy "provider" column: the column is
    // dropped again below, and Postgres never frees a dropped column's slot, so
    // re-adding it on every boot eventually hits the 1600-column limit.
    const [legacy_provider] = await sq.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'cliq' AND table_name = 'notification_channels' AND column_name = 'provider'
    `);
    const backfill_destinations_sql = `
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
    `;
    if (legacy_provider.length > 0) {
        await run(`ALTER TABLE cliq."notification_channels"
                   ADD COLUMN IF NOT EXISTS "destinations" TEXT NOT NULL DEFAULT '[]'`);
        await run(backfill_destinations_sql);
    }

    // ── Org-as-account: org_id on channels and rules ────────────────
    await run(`ALTER TABLE cliq."notification_channels"
               ADD COLUMN IF NOT EXISTS "org_id" UUID`);
    await run(`CREATE INDEX IF NOT EXISTS "notification_channels_org_id_idx"
               ON cliq."notification_channels" ("org_id")`);

    await run(`ALTER TABLE cliq."notification_rules"
               ADD COLUMN IF NOT EXISTS "org_id" UUID`);
    await run(`CREATE INDEX IF NOT EXISTS "notification_rules_org_id_idx"
               ON cliq."notification_rules" ("org_id")`);

    // ── notification_rules.enabled: a rule sends only when it and its channel are on ──
    // A realm's rules for an event replace the org's there even when switched off (that's "off in this realm").
    await run(`ALTER TABLE cliq."notification_rules"
               ADD COLUMN IF NOT EXISTS "enabled" BOOLEAN NOT NULL DEFAULT true`);

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
    // Version-controlled seed: src/data/model_pricing.json (services/model_pricing_seed.ts, at boot).
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
    // Cache-read price (null: cached tokens are priced as input).
    await run(`ALTER TABLE cliq."model_pricing" ADD COLUMN IF NOT EXISTS "cached_input_per_1m" NUMERIC(12, 6)`);

    // Daemon team slots outlive an uninstall (runs keep their team; a reinstall
    // keeps the id). Rows detached by the old prune (daemon_id NULL) count as
    // uninstalled and are never claimed again.
    await run(`ALTER TABLE cliq."daemon_teams" ADD COLUMN IF NOT EXISTS "uninstalled_at" BIGINT`);
    // Deleted workspaces are kept (marked) so their runs are never cascade-deleted.
    await run(`ALTER TABLE cliq."workspaces" ADD COLUMN IF NOT EXISTS "deleted_at" BIGINT`);
    await run(`UPDATE cliq."daemon_teams" SET "uninstalled_at" = "updated_at"
               WHERE "daemon_id" IS NULL AND "uninstalled_at" IS NULL`);

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
    // One personal channel per user (PLAN-personal-channel). Fails quietly until the one-time merge of the
    // old per-org copies has run (migrate_personal_channel_per_user creates it then).
    await run(`DROP INDEX IF EXISTS cliq."notification_channels_user_org_uidx"`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS "notification_channels_user_uidx"
        ON cliq."notification_channels" ("user_id")
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

    /** Ensure every org member with a username has a personal notification channel. */
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

    // ── Stored artifacts: durable file uploads from agent phases ──────
    // Files are stored in R2; this table holds metadata + references.
    // Completely independent of run_artifacts (runtime event store).

    await run(`CREATE TABLE IF NOT EXISTS cliq."stored_artifacts" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "run_id"      TEXT NOT NULL,
        "phase"       TEXT NOT NULL,
        "name"        TEXT NOT NULL,
        "description" TEXT,
        "mime_type"   TEXT NOT NULL,
        "size_bytes"  BIGINT NOT NULL,
        "storage_key" TEXT NOT NULL,
        "uploaded_by" TEXT,
        "created_at"  BIGINT NOT NULL
    )`);
    await run(`CREATE INDEX IF NOT EXISTS "stored_artifacts_run_id_idx"
               ON cliq."stored_artifacts" ("run_id")`);

    // cliq."teams" is the registry's team catalog (daemon installs live in
    // cliq."daemon_teams"); boot must never rename, merge or drop it.

    // Fork lineage: the team (and version) a team was forked from.
    await run(`ALTER TABLE cliq."teams" ADD COLUMN IF NOT EXISTS "forked_from_team_id" UUID`);
    await run(`ALTER TABLE cliq."teams" ADD COLUMN IF NOT EXISTS "forked_from_version" TEXT`);
    await run(`CREATE INDEX IF NOT EXISTS "teams_forked_from_idx" ON cliq."teams" ("forked_from_team_id") WHERE "forked_from_team_id" IS NOT NULL`);
    // Working copy: edits saved without minting a version until the editor saves a version.
    await run(`ALTER TABLE cliq."teams" ADD COLUMN IF NOT EXISTS "draft_manifest" TEXT`);
    await run(`ALTER TABLE cliq."teams" ADD COLUMN IF NOT EXISTS "draft_description" TEXT`);
    await run(`ALTER TABLE cliq."teams" ADD COLUMN IF NOT EXISTS "draft_saved_at" TIMESTAMPTZ`);
    // A version's dependencies.yml (tools the team needs and how to install them) — shown in the builder.
    await run(`ALTER TABLE cliq."team_versions" ADD COLUMN IF NOT EXISTS "dependencies_yaml" TEXT NOT NULL DEFAULT ''`);

    // Org team library: teams an org has taken on (from the marketplace or its own
    // scopes). A team joins the org before any of the org's realms can add it.
    await run(`
        CREATE TABLE IF NOT EXISTS cliq."org_teams" (
            "org_id" UUID NOT NULL REFERENCES cliq."orgs" ("id") ON DELETE CASCADE,
            "team_id" UUID NOT NULL REFERENCES cliq."teams" ("id") ON DELETE CASCADE,
            "added_by" UUID,
            "added_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY ("org_id", "team_id")
        )
    `);
    await run(`CREATE INDEX IF NOT EXISTS "org_teams_team_idx" ON cliq."org_teams" ("team_id")`);
    // Teams already on a realm's team list are in that realm's org.
    await run(`
        INSERT INTO cliq."org_teams" ("org_id", "team_id")
        SELECT DISTINCT r."org_id", t."id"
          FROM cliq."realms" r
          CROSS JOIN LATERAL jsonb_array_elements(r."team_list") e
          JOIN cliq."teams" t ON t."name" = e->>'slug' AND t."scope" IS NOT DISTINCT FROM NULLIF(e->>'scope', '')
         WHERE r."org_id" IS NOT NULL
        ON CONFLICT DO NOTHING
    `);

    // Add is_default column to cliq.scopes (registry) so the platform default
    // scope ('cliq') can be identified without a separate control-plane table.
    await run(`ALTER TABLE cliq."scopes" ADD COLUMN IF NOT EXISTS "is_default" INTEGER NOT NULL DEFAULT 0`);
    // Allow owner_id to be NULL for platform-owned scopes.
    await run(`ALTER TABLE cliq."scopes" ALTER COLUMN "owner_id" DROP NOT NULL`);

    // Seed the platform scope into the registry scopes table.
    await run(`
        INSERT INTO cliq."scopes" ("id", "slug", "display_name", "owner_id", "visibility", "scope_type", "is_default", "created_at")
        VALUES
            (gen_random_uuid(), 'cliq', 'Cliq', NULL, 'public', 'platform', 1, NOW())
        ON CONFLICT ("slug") DO UPDATE SET "is_default" = EXCLUDED."is_default"
    `);

    // 'measureone' is no longer a platform scope; free the name unless something already lives in it.
    await run(`
        DELETE FROM cliq."scopes" s
        WHERE s."slug" = 'measureone' AND s."scope_type" = 'platform'
          AND s."org_id" IS NULL AND s."owner_id" IS NULL
          AND NOT EXISTS (SELECT 1 FROM cliq."teams" t WHERE t."scope" = s."slug")
          AND NOT EXISTS (SELECT 1 FROM cliq."scope_members" sm WHERE sm."scope_id" = s."id")
          AND NOT EXISTS (SELECT 1 FROM cliq."daemon_teams" dt WHERE dt."scope_id"::text = s."id"::text)
    `);

    // Migrate daemon_teams.scope_id from old cliq.scopes fixed UUIDs to registry scope UUIDs.
    await run(`
        UPDATE cliq."daemon_teams" dt
        SET "scope_id" = (SELECT "id" FROM cliq."scopes" WHERE "slug" = 'cliq')
        WHERE dt."scope_id" = '00000000-0000-0000-0000-000000000000'
    `);
    // cliq."scopes" is the live registry table (moved out of public); never drop it here.
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
            _mig_log.error('coerce_user_id_column_failed', { table: `${tgt.schema}.${tgt.table}`, column: tgt.column, error: (err as Error)?.message ?? String(err) });
        }
    }
}

async function backfill_per_user_channels(sq: Sequelize): Promise<void> {
    try {
        /** A personal channel for every user who has none — one per account, no org (PLAN-personal-channel). */
        await sq.query(`
            INSERT INTO cliq."notification_channels"
                ("id", "realm_id", "org_id", "user_id", "name",
                 "enabled", "created_at", "updated_at")
            SELECT
                gen_random_uuid()::TEXT,
                NULL,
                NULL,
                u."id",
                u."username",
                1,
                EXTRACT(EPOCH FROM NOW()) * 1000,
                EXTRACT(EPOCH FROM NOW()) * 1000
            FROM cliq."users" u
            WHERE u."username" IS NOT NULL AND u."deleted_at" IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM cliq."notification_channels" nc
                WHERE nc."user_id"::text = u."id"::text
            )
        `);

        /** A personal channel with no destinations (just created above) gets the defaults: in-app and account email. */
        await sq.query(`
            INSERT INTO cliq."channel_destinations"
                ("id", "channel_id", "type", "config", "created_at")
            SELECT
                gen_random_uuid()::TEXT,
                nc."id",
                d."type",
                d."config"::jsonb,
                EXTRACT(EPOCH FROM NOW()) * 1000
            FROM cliq."notification_channels" nc
            CROSS JOIN (VALUES ('cliqhub', '{}'), ('email', '{"account": true}')) AS d("type", "config")
            WHERE nc."user_id" IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM cliq."channel_destinations" cd
                WHERE cd."channel_id" = nc."id"
              )
        `);
    } catch (err) {
        _mig_log.error('backfill_per_user_channels_failed', { error: (err as Error)?.message ?? String(err) });
    }
    await backfill_personal_channel_email(sq);
    await migrate_realm_members_channels(sq);
    await migrate_built_in_messages(sq);
    await grant_admin_rules_manage(sq);
    await add_realm_review_rule(sq);
    await migrate_builtin_channels(sq);
    await migrate_default_rules(sq);
    await migrate_account_scopes(sq);
    await migrate_removed_event_rules(sq);
    await revoke_admin_test_tokens(sq);
    await migrate_realm_team_list_versions(sq);
    await migrate_personal_channel_per_user(sq);
}

/** `cliq.settings` key marking the one-time email backfill as done. */
export const PERSONAL_EMAIL_BACKFILL_KEY = 'backfill.personal_channel_email_2026_10';

/**
 * One time (Oct 2026): every personal channel without an email destination gets one that sends
 * to the owner's account email. Tagged `added_by: 'backfill-2026-10'` so it can be found and
 * removed. Runs once — the `cliq.settings` key {@link PERSONAL_EMAIL_BACKFILL_KEY} records it —
 * so an email destination someone removes later is not put back on the next boot.
 */
export async function backfill_personal_channel_email(sq: Sequelize): Promise<void> {
    try {
        const [table] = await sq.query(`SELECT to_regclass('cliq.settings') AS t`, { type: QueryTypes.SELECT }) as Array<{ t: string | null }>;
        if (!table?.t) {
            _mig_log.info('personal_channel_email_backfill_deferred', { reason: 'cliq.settings not created yet' });
            return;
        }
        await sq.transaction(async (t) => {
            // Take the marker first: a second Core booting at the same time waits here, then sees it.
            const claimed = await sq.query(
                `INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW())
                 ON CONFLICT ("key") DO NOTHING RETURNING "key"`,
                { replacements: { key: PERSONAL_EMAIL_BACKFILL_KEY, value: new Date().toISOString() }, transaction: t, type: QueryTypes.SELECT },
            );
            if (claimed.length === 0) return;
            const added = await sq.query(`
                INSERT INTO cliq."channel_destinations" ("id", "channel_id", "type", "config", "created_at")
                SELECT gen_random_uuid()::TEXT, nc."id", 'email',
                       '{"account": true, "added_by": "backfill-2026-10"}'::jsonb,
                       EXTRACT(EPOCH FROM NOW()) * 1000
                FROM cliq."notification_channels" nc
                WHERE nc."user_id" IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM cliq."channel_destinations" cd
                    WHERE cd."channel_id" = nc."id" AND cd."type" = 'email'
                  )
                RETURNING "id"
            `, { transaction: t, type: QueryTypes.SELECT });
            _mig_log.info('personal_channel_email_backfilled', { channels: added.length });
        });
    } catch (err) {
        _mig_log.error('personal_channel_email_backfill_failed', { error: (err as Error)?.message ?? String(err) });
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
               FROM cliq.team_versions`,
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
                `UPDATE cliq.team_versions SET capability_json = $1 WHERE id = $2`,
                { bind: [JSON.stringify(capability), row.id] },
            );
        } catch {
            /* best-effort per row */
        }
    }
}




/** `cliq.settings` key marking the one-time realm channel migration as done. */
export const REALM_MEMBERS_MIGRATION_KEY = 'migrate.realm_members_channels_2026_10';

/**
 * The default rules this migration gives existing realms — frozen as they were when it was written
 * (7ecba12); later default changes (notifications/defaults.ts) have their own migrations.
 */
export const REALM_MEMBERS_MIGRATION_EVENTS = ['phase.input_required', 'phase.idle', 'phase.timed_out', 'run.failed', 'run.crashed'] as const;

/**
 * One time (Oct 2026), explicit channels:
 *   1. rules people created on channels with no destinations (they delivered nothing) and those
 *      empty shared channels are deleted;
 *   2. the hidden per-realm `realm:all_users` channels are deleted (their fallback is gone);
 *   3. every realm gets its "All realm members" channel (the legacy `cliqhub` realm channel is
 *      renamed) with the default rules that replace that fallback, so what reaches members stays
 *      the same.
 * Runs once — the `cliq.settings` key {@link REALM_MEMBERS_MIGRATION_KEY} is recorded after every
 * step succeeded — so default rules someone removes later are not put back.
 */
export async function migrate_realm_members_channels(sq: Sequelize): Promise<void> {
    try {
        const [table] = await sq.query(`SELECT to_regclass('cliq.settings') AS t`, { type: QueryTypes.SELECT }) as Array<{ t: string | null }>;
        if (!table?.t) {
            _mig_log.info('realm_members_migration_deferred', { reason: 'cliq.settings not created yet' });
            return;
        }
        const done = await sq.query(`SELECT 1 FROM cliq."settings" WHERE "key" = :key`,
            { replacements: { key: REALM_MEMBERS_MIGRATION_KEY }, type: QueryTypes.SELECT });
        if (done.length > 0) return;

        // Every step below is safe to repeat; the key is recorded only once all of them succeeded.
        const empty = `SELECT c."id" FROM cliq."notification_channels" c
            WHERE c."user_id" IS NULL AND c."system_key" IS NULL
              AND NOT EXISTS (SELECT 1 FROM cliq."channel_destinations" d WHERE d."channel_id" = c."id")`;
        const dead_rules = await sq.query(
            `DELETE FROM cliq."notification_rules" WHERE "channel_id" IN (${empty}) RETURNING "id"`, { type: QueryTypes.SELECT });
        const empty_channels = await sq.query(
            `DELETE FROM cliq."notification_channels" WHERE "id" IN (${empty}) RETURNING "id"`, { type: QueryTypes.SELECT });
        const all_users = `SELECT "id" FROM cliq."notification_channels" WHERE "name" = 'realm:all_users' OR "id" LIKE 'all_users-%'`;
        await sq.query(`DELETE FROM cliq."notification_rules" WHERE "channel_id" IN (${all_users})`);
        await sq.query(`DELETE FROM cliq."channel_destinations" WHERE "channel_id" IN (${all_users})`);
        const all_users_channels = await sq.query(
            `DELETE FROM cliq."notification_channels" WHERE "id" IN (${all_users}) RETURNING "id"`, { type: QueryTypes.SELECT });

        const { NotificationService } = await import('../../services/notification.service.js');
        const realms = await sq.query(
            `SELECT "id" FROM cliq."realms" WHERE COALESCE("deleted", false) = false`, { type: QueryTypes.SELECT }) as Array<{ id: string }>;
        let default_rules = 0;
        for (const { id: realm_id } of realms) {
            const channel = await NotificationService.ensure_realm_members_channel(realm_id);
            for (const event of REALM_MEMBERS_MIGRATION_EVENTS) {
                const added = await sq.query(
                    `INSERT INTO cliq."notification_rules"
                        ("id", "realm_id", "org_id", "team_slug", "event", "channel_id", "priority", "recipients",
                         "system_key", "locked", "lock_reason", "created_at", "updated_at")
                     SELECT gen_random_uuid(), :realm_id, NULL, NULL, :event, :channel_id, 0, NULL,
                            :system_key, false, NULL, EXTRACT(EPOCH FROM NOW()) * 1000, EXTRACT(EPOCH FROM NOW()) * 1000
                     WHERE NOT EXISTS (
                        SELECT 1 FROM cliq."notification_rules"
                        WHERE "realm_id" = :realm_id AND "team_slug" IS NULL AND "event" = :event AND "channel_id" = :channel_id
                     )
                     RETURNING "id"`,
                    { replacements: { realm_id, event, channel_id: channel.id, system_key: `realm.members.${event}` }, type: QueryTypes.SELECT },
                );
                default_rules += added.length;
            }
        }
        await sq.query(
            `INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW()) ON CONFLICT ("key") DO NOTHING`,
            { replacements: { key: REALM_MEMBERS_MIGRATION_KEY, value: new Date().toISOString() } },
        );
        _mig_log.info('realm_members_channels_migrated', {
            dead_rules_deleted: dead_rules.length,
            empty_channels_deleted: empty_channels.length,
            all_users_channels_deleted: all_users_channels.length,
            realms: realms.length,
            default_rules_added: default_rules,
        });
    } catch (err) {
        _mig_log.error('realm_members_migration_failed', { error: (err as Error)?.message ?? String(err) });
    }
}

/** `cliq.settings` key marking the one-time move to built-in invite/account messages as done. */
export const BUILT_IN_MESSAGES_MIGRATION_KEY = 'migrate.built_in_messages_2026_10';

/**
 * One time (Oct 2026): invite and account messages are built in, not rules. Deletes the seeded org
 * rules (org-level rules with a `system_key`; a realm's default rules stay), each org's system
 * Email channel (and anything pointing at it), and unlocks the org "In-app" channel, which stays as
 * an ordinary org channel. Steps are safe to repeat; the key is recorded once all succeeded.
 */
export async function migrate_built_in_messages(sq: Sequelize): Promise<void> {
    try {
        const [table] = await sq.query(`SELECT to_regclass('cliq.settings') AS t`, { type: QueryTypes.SELECT }) as Array<{ t: string | null }>;
        if (!table?.t) {
            _mig_log.info('built_in_messages_migration_deferred', { reason: 'cliq.settings not created yet' });
            return;
        }
        const done = await sq.query(`SELECT 1 FROM cliq."settings" WHERE "key" = :key`,
            { replacements: { key: BUILT_IN_MESSAGES_MIGRATION_KEY }, type: QueryTypes.SELECT });
        if (done.length > 0) return;

        const seeded_rules = await sq.query(
            `DELETE FROM cliq."notification_rules" WHERE "realm_id" IS NULL AND "system_key" IS NOT NULL RETURNING "id"`,
            { type: QueryTypes.SELECT });
        const email = `SELECT "id" FROM cliq."notification_channels" WHERE "system_key" = 'org.email'`;
        const email_rules = await sq.query(`DELETE FROM cliq."notification_rules" WHERE "channel_id" IN (${email}) RETURNING "id"`, { type: QueryTypes.SELECT });
        await sq.query(`DELETE FROM cliq."channel_destinations" WHERE "channel_id" IN (${email})`);
        const email_channels = await sq.query(`DELETE FROM cliq."notification_channels" WHERE "id" IN (${email}) RETURNING "id"`, { type: QueryTypes.SELECT });
        const unlocked = await sq.query(
            `UPDATE cliq."notification_channels" SET "locked" = false, "lock_reason" = NULL
             WHERE "system_key" = 'org.in_app' AND ("locked" = true OR "lock_reason" IS NOT NULL) RETURNING "id"`,
            { type: QueryTypes.SELECT });

        await sq.query(
            `INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW()) ON CONFLICT ("key") DO NOTHING`,
            { replacements: { key: BUILT_IN_MESSAGES_MIGRATION_KEY, value: new Date().toISOString() } },
        );
        _mig_log.info('built_in_messages_migrated', {
            seeded_rules_deleted: seeded_rules.length,
            rules_on_email_channel_deleted: email_rules.length,
            email_channels_deleted: email_channels.length,
            in_app_channels_unlocked: unlocked.length,
        });
    } catch (err) {
        _mig_log.error('built_in_messages_migration_failed', { error: (err as Error)?.message ?? String(err) });
    }
}

/** `cliq.settings` key marking the one-time grant of `rules.manage` to Admin roles as done. */
export const ADMIN_RULES_MANAGE_KEY = 'migrate.admin_rules_manage_2026_10';

/**
 * One time (Oct 2026): `rules.manage` (org-wide notification rules) is no longer owner-only; it is
 * an ordinary permission and part of the default Admin role. Adds it to each org's existing default
 * `admin` role. Other roles get it only when someone grants it.
 */
export async function grant_admin_rules_manage(sq: Sequelize): Promise<void> {
    try {
        const [tables] = await sq.query(`SELECT to_regclass('cliq.settings') AS s, to_regclass('cliq.org_roles') AS r`, { type: QueryTypes.SELECT }) as Array<{ s: string | null; r: string | null }>;
        if (!tables?.s || !tables?.r) {
            _mig_log.info('admin_rules_manage_deferred', { reason: 'cliq.settings or cliq.org_roles not created yet' });
            return;
        }
        const done = await sq.query(`SELECT 1 FROM cliq."settings" WHERE "key" = :key`,
            { replacements: { key: ADMIN_RULES_MANAGE_KEY }, type: QueryTypes.SELECT });
        if (done.length > 0) return;

        const roles = await sq.query(
            `UPDATE cliq."org_roles" SET "permissions" = array_append("permissions", 'rules.manage')
             WHERE "slug" = 'admin' AND "is_system" = false AND NOT ('rules.manage' = ANY("permissions")) RETURNING "id"`,
            { type: QueryTypes.SELECT });

        await sq.query(
            `INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW()) ON CONFLICT ("key") DO NOTHING`,
            { replacements: { key: ADMIN_RULES_MANAGE_KEY, value: new Date().toISOString() } },
        );
        _mig_log.info('admin_rules_manage_granted', { roles: roles.length });
    } catch (err) {
        _mig_log.error('admin_rules_manage_failed', { error: (err as Error)?.message ?? String(err) });
    }
}

/** `cliq.settings` key marking the one-time review-request rule for existing realms as done. */
export const REALM_REVIEW_RULE_KEY = 'migrate.realm_review_rule_2026_10';

/**
 * One time (Oct 2026): every realm is provisioned with a rule sending `hug.review_requested` to its
 * "All realm members" channel — the people a review request reaches are the ones who can answer it.
 * Adds that rule to each live realm that has no realm rule for review requests yet (`hug.review_requested`,
 * `hug.*` or `*`); a realm that already routes them keeps its own choice.
 */
export async function add_realm_review_rule(sq: Sequelize): Promise<void> {
    try {
        const [tables] = await sq.query(`SELECT to_regclass('cliq.settings') AS s, to_regclass('cliq.notification_rules') AS r`, { type: QueryTypes.SELECT }) as Array<{ s: string | null; r: string | null }>;
        if (!tables?.s || !tables?.r) {
            _mig_log.info('realm_review_rule_deferred', { reason: 'cliq.settings or cliq.notification_rules not created yet' });
            return;
        }
        const done = await sq.query(`SELECT 1 FROM cliq."settings" WHERE "key" = :key`,
            { replacements: { key: REALM_REVIEW_RULE_KEY }, type: QueryTypes.SELECT });
        if (done.length > 0) return;

        const { NotificationService } = await import('../../services/notification.service.js');
        const realms = await sq.query(
            `SELECT r."id" FROM cliq."realms" r
             WHERE COALESCE(r."deleted", false) = false
               AND NOT EXISTS (
                 SELECT 1 FROM cliq."notification_rules" nr
                 WHERE nr."realm_id" = r."id" AND nr."team_slug" IS NULL
                   AND nr."event" IN ('hug.review_requested', 'hug.*', '*')
               )`, { type: QueryTypes.SELECT }) as Array<{ id: string }>;
        let added = 0;
        for (const { id: realm_id } of realms) {
            // The realm's channel as its owners left it (switched off stays off); created only when missing.
            const [existing] = await sq.query(`SELECT "id" FROM cliq."notification_channels" WHERE "id" = :id`,
                { replacements: { id: `cliqhub-${realm_id}` }, type: QueryTypes.SELECT }) as Array<{ id: string }>;
            const channel_id = existing?.id ?? (await NotificationService.ensure_realm_members_channel(realm_id)).id;
            const rows = await sq.query(
                `INSERT INTO cliq."notification_rules"
                    ("id", "realm_id", "org_id", "team_slug", "event", "channel_id", "priority", "recipients",
                     "system_key", "locked", "lock_reason", "created_at", "updated_at")
                 SELECT gen_random_uuid(), :realm_id, NULL, NULL, 'hug.review_requested', :channel_id, 0, NULL,
                        'realm.members.hug.review_requested', false, NULL, EXTRACT(EPOCH FROM NOW()) * 1000, EXTRACT(EPOCH FROM NOW()) * 1000
                 WHERE NOT EXISTS (
                    SELECT 1 FROM cliq."notification_rules"
                    WHERE "realm_id" = :realm_id AND "team_slug" IS NULL AND "event" = 'hug.review_requested'
                 )
                 RETURNING "id"`,
                { replacements: { realm_id, channel_id }, type: QueryTypes.SELECT },
            );
            added += rows.length;
        }

        await sq.query(
            `INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW()) ON CONFLICT ("key") DO NOTHING`,
            { replacements: { key: REALM_REVIEW_RULE_KEY, value: new Date().toISOString() } },
        );
        _mig_log.info('realm_review_rule_added', { realms: realms.length, rules_added: added });
    } catch (err) {
        _mig_log.error('realm_review_rule_failed', { error: (err as Error)?.message ?? String(err) });
    }
}

/** `cliq.settings` key marking the one-time move to locked built-in channels as done. */
export const BUILTIN_CHANNELS_MIGRATION_KEY = 'migrate.builtin_channels_2026_10';

/** What this migration makes the built-in channels — frozen as written (PLAN-notifications-v2 A2). */
const BUILTIN_CHANNELS_2026_10 = {
    org: { system_key: 'org.in_app', old_name: 'In-app', name: 'All org members', lock_reason: 'Built in — in-app and email to every member of the org.' },
    realm: { system_key: 'realm.members', lock_reason: 'Built in — in-app and email to every member of the realm.' },
    destinations: [{ type: 'cliqhub', config: {} }, { type: 'email', config: { members: true } }],
} as const;

/**
 * One time (Oct 2026): the org's "In-app" channel and each realm's "All realm members" become built-in,
 * locked channels with two destinations — in-app and email to their members.
 * - Org: `org.in_app` → renamed "All org members" (only while it still has its seeded name "In-app" and
 *   the org has no other channel by that name), email-to-members added, locked, on.
 * - Realm: `cliqhub-<realm>` (or the realm's channel named "All realm members" / "cliqhub") → system key
 *   `realm.members`, email-to-members added, locked, on (built-in channels are always on). A live realm
 *   without one gets it with its default rules.
 * Rules are not touched. Safe to repeat; the key is recorded once everything succeeded.
 */
export async function migrate_builtin_channels(sq: Sequelize): Promise<void> {
    try {
        const [tables] = await sq.query(`SELECT to_regclass('cliq.settings') AS s, to_regclass('cliq.notification_channels') AS c`, { type: QueryTypes.SELECT }) as Array<{ s: string | null; c: string | null }>;
        if (!tables?.s || !tables?.c) {
            _mig_log.info('builtin_channels_deferred', { reason: 'cliq.settings or cliq.notification_channels not created yet' });
            return;
        }
        const done = await sq.query(`SELECT 1 FROM cliq."settings" WHERE "key" = :key`,
            { replacements: { key: BUILTIN_CHANNELS_MIGRATION_KEY }, type: QueryTypes.SELECT });
        if (done.length > 0) return;

        const spec = BUILTIN_CHANNELS_2026_10;
        const add_destinations = async (channel_id: string) => {
            for (const d of spec.destinations) {
                await sq.query(
                    `INSERT INTO cliq."channel_destinations" ("id", "channel_id", "type", "config", "created_at")
                     SELECT gen_random_uuid(), :channel_id, :type, CAST(:config AS jsonb), EXTRACT(EPOCH FROM NOW()) * 1000
                     WHERE NOT EXISTS (SELECT 1 FROM cliq."channel_destinations" WHERE "channel_id" = :channel_id AND "type" = :type)`,
                    { replacements: { channel_id, type: d.type, config: JSON.stringify(d.config) } },
                );
            }
        };

        // Orgs: the seeded In-app channel.
        const org_channels = await sq.query(
            `SELECT c."id", c."org_id", c."name" FROM cliq."notification_channels" c
             JOIN cliq."orgs" o ON o."id"::text = c."org_id"::text AND o."deleted_at" IS NULL
             WHERE c."system_key" = :key AND c."realm_id" IS NULL AND c."user_id" IS NULL`,
            { replacements: { key: spec.org.system_key }, type: QueryTypes.SELECT }) as Array<{ id: string; org_id: string; name: string }>;
        let orgs_renamed = 0;
        for (const c of org_channels) {
            const [taken] = await sq.query(
                `SELECT 1 AS t FROM cliq."notification_channels" WHERE "org_id"::text = :org_id AND "realm_id" IS NULL AND "name" = :name AND "id" <> :id`,
                { replacements: { org_id: String(c.org_id), name: spec.org.name, id: c.id }, type: QueryTypes.SELECT }) as Array<{ t: number }>;
            const rename = c.name === spec.org.old_name && !taken;
            await sq.query(
                `UPDATE cliq."notification_channels" SET "locked" = true, "lock_reason" = :reason, "enabled" = 1,
                    "name" = CASE WHEN :rename THEN :name ELSE "name" END, "updated_at" = EXTRACT(EPOCH FROM NOW()) * 1000
                 WHERE "id" = :id`,
                { replacements: { reason: spec.org.lock_reason, rename, name: spec.org.name, id: c.id } },
            );
            if (rename) orgs_renamed += 1;
            await add_destinations(c.id);
        }

        // Realms: their All realm members channel.
        const { NotificationService } = await import('../../services/notification.service.js');
        const realms = await sq.query(
            `SELECT "id" FROM cliq."realms" WHERE COALESCE("deleted", false) = false`, { type: QueryTypes.SELECT }) as Array<{ id: string }>;
        let realm_channels_created = 0;
        let realm_channels_turned_on = 0;
        for (const { id: realm_id } of realms) {
            const [ch] = await sq.query(
                `SELECT "id", "enabled" FROM cliq."notification_channels"
                 WHERE "id" = :cid OR ("realm_id"::text = :realm_id AND "user_id" IS NULL AND "name" IN ('All realm members', 'cliqhub'))
                 ORDER BY ("id" = :cid) DESC LIMIT 1`,
                { replacements: { cid: `cliqhub-${realm_id}`, realm_id }, type: QueryTypes.SELECT }) as Array<{ id: string; enabled: number }>;
            if (!ch) {
                await NotificationService.ensure_realm_members_channel(realm_id);
                realm_channels_created += 1;
                continue;
            }
            if (Number(ch.enabled) !== 1) realm_channels_turned_on += 1;
            await sq.query(
                `UPDATE cliq."notification_channels" SET "system_key" = :key, "locked" = true, "lock_reason" = :reason, "enabled" = 1,
                    "name" = 'All realm members', "updated_at" = EXTRACT(EPOCH FROM NOW()) * 1000
                 WHERE "id" = :id`,
                { replacements: { key: spec.realm.system_key, reason: spec.realm.lock_reason, id: ch.id } },
            );
            await add_destinations(ch.id);
        }

        await sq.query(
            `INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW()) ON CONFLICT ("key") DO NOTHING`,
            { replacements: { key: BUILTIN_CHANNELS_MIGRATION_KEY, value: new Date().toISOString() } },
        );
        _mig_log.info('builtin_channels_migrated', {
            org_channels: org_channels.length, orgs_renamed, realms: realms.length, realm_channels_created, realm_channels_turned_on,
        });
    } catch (err) {
        _mig_log.error('builtin_channels_migration_failed', { error: (err as Error)?.message ?? String(err) });
    }
}

/** `cliq.settings` key marking the one-time fixed-rule change (A3) as done. */
export const DEFAULT_RULES_MIGRATION_KEY = 'migrate.default_rules_2026_10';

/** What this migration does — frozen as written (PLAN-notifications-v2 A3). */
const DEFAULT_RULES_2026_10 = {
    fixed: { event: 'notification.unknown_channel', system_key: 'realm.members.notification.unknown_channel', lock_reason: 'Built in — a channel that doesn’t exist always reaches the realm.' },
} as const;

/**
 * One time (Oct 2026): every live realm gets the fixed, locked rule
 * `notification.unknown_channel → All realm members`. A realm's other rules are untouched. (Removing the
 * review-request default waits for reviews to always name their reviewers — B3/B4.) Safe to repeat; the
 * key is recorded once everything succeeded.
 */
export async function migrate_default_rules(sq: Sequelize): Promise<void> {
    try {
        const [tables] = await sq.query(`SELECT to_regclass('cliq.settings') AS s, to_regclass('cliq.notification_rules') AS r`, { type: QueryTypes.SELECT }) as Array<{ s: string | null; r: string | null }>;
        if (!tables?.s || !tables?.r) {
            _mig_log.info('default_rules_deferred', { reason: 'cliq.settings or cliq.notification_rules not created yet' });
            return;
        }
        const done = await sq.query(`SELECT 1 FROM cliq."settings" WHERE "key" = :key`,
            { replacements: { key: DEFAULT_RULES_MIGRATION_KEY }, type: QueryTypes.SELECT });
        if (done.length > 0) return;

        const spec = DEFAULT_RULES_2026_10;

        const realms = await sq.query(
            `SELECT r."id", c."id" AS channel_id FROM cliq."realms" r
             JOIN cliq."notification_channels" c ON c."id" = 'cliqhub-' || r."id"
             WHERE COALESCE(r."deleted", false) = false`, { type: QueryTypes.SELECT }) as Array<{ id: string; channel_id: string }>;
        let fixed_added = 0;
        for (const { id: realm_id, channel_id } of realms) {
            const added = await sq.query(
                `INSERT INTO cliq."notification_rules"
                    ("id", "realm_id", "org_id", "team_slug", "event", "channel_id", "priority", "recipients",
                     "system_key", "locked", "lock_reason", "created_at", "updated_at")
                 SELECT gen_random_uuid(), :realm_id, NULL, NULL, :event, :channel_id, 0, NULL,
                        :system_key, true, :reason, EXTRACT(EPOCH FROM NOW()) * 1000, EXTRACT(EPOCH FROM NOW()) * 1000
                 WHERE NOT EXISTS (
                    SELECT 1 FROM cliq."notification_rules"
                    WHERE "realm_id" = :realm_id AND "team_slug" IS NULL AND "event" = :event AND "channel_id" = :channel_id
                 )
                 RETURNING "id"`,
                { replacements: { realm_id, channel_id, event: spec.fixed.event, system_key: spec.fixed.system_key, reason: spec.fixed.lock_reason }, type: QueryTypes.SELECT },
            );
            fixed_added += added.length;
        }

        await sq.query(
            `INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW()) ON CONFLICT ("key") DO NOTHING`,
            { replacements: { key: DEFAULT_RULES_MIGRATION_KEY, value: new Date().toISOString() } },
        );
        _mig_log.info('default_rules_migrated', { realms: realms.length, fixed_added });
    } catch (err) {
        _mig_log.error('default_rules_migration_failed', { error: (err as Error)?.message ?? String(err) });
    }
}

/** `cliq.settings` key marking the one-time account-scope fix as done. */
export const ACCOUNT_SCOPES_MIGRATION_KEY = 'migrate.account_scopes_2026_10';

/**
 * One time (Oct 2026): every account org (a user's own org — a member's username is the org's slug) gets its
 * scope the way signup makes it, frozen as written: a scope named after the username, public, owned by the
 * user and linked to the org (created when missing; the user's own unlinked scope of that name is linked);
 * the user a member of it; and the org's default scope when it has none. A scope of that name owned by
 * someone else is left alone. Accounts made before signup created the scope, or through an invite / by an
 * admin, had none or an unlinked one. Safe to repeat; the key is recorded once everything succeeded.
 */
export async function migrate_account_scopes(sq: Sequelize): Promise<void> {
    try {
        const [tables] = await sq.query(`SELECT to_regclass('cliq.settings') AS s, to_regclass('cliq.scope_members') AS m`, { type: QueryTypes.SELECT }) as Array<{ s: string | null; m: string | null }>;
        if (!tables?.s || !tables?.m) {
            _mig_log.info('account_scopes_deferred', { reason: 'cliq.settings or cliq.scope_members not created yet' });
            return;
        }
        const done = await sq.query(`SELECT 1 FROM cliq."settings" WHERE "key" = :key`,
            { replacements: { key: ACCOUNT_SCOPES_MIGRATION_KEY }, type: QueryTypes.SELECT });
        if (done.length > 0) return;

        const accounts = await sq.query(
            `SELECT DISTINCT ON (o."id") o."id" AS org_id, o."slug", u."id" AS user_id, COALESCE(NULLIF(u."display_name", ''), u."username") AS display_name
             FROM cliq."orgs" o
             JOIN cliq."org_members" om ON om."org_id" = o."id"
             JOIN cliq."users" u ON u."id"::text = om."user_id"::text AND lower(u."username") = lower(o."slug")
             WHERE o."deleted_at" IS NULL AND u."deleted_at" IS NULL
             ORDER BY o."id"`, { type: QueryTypes.SELECT }) as Array<{ org_id: string; slug: string; user_id: string; display_name: string }>;
        let created = 0; let linked = 0; let other_owner = 0;
        for (const a of accounts) {
            const [found] = await sq.query(`SELECT "id", "owner_id", "org_id" FROM cliq."scopes" WHERE lower("slug") = lower(:slug)`,
                { replacements: { slug: a.slug }, type: QueryTypes.SELECT }) as Array<{ id: string; owner_id: string | null; org_id: string | null }>;
            let scope_id: string;
            if (!found) {
                const [row] = await sq.query(
                    `INSERT INTO cliq."scopes" ("id", "slug", "display_name", "owner_id", "org_id", "visibility", "scope_type", "created_at", "is_default")
                     VALUES (gen_random_uuid(), :slug, :display_name, :user_id, :org_id, 'public', 'org', NOW(), 0) RETURNING "id"`,
                    { replacements: { slug: a.slug, display_name: a.display_name, user_id: a.user_id, org_id: a.org_id }, type: QueryTypes.SELECT },
                ) as Array<{ id: string }>;
                scope_id = row.id;
                created++;
            } else if (String(found.owner_id) !== String(a.user_id)) {
                other_owner++;
                continue;
            } else {
                scope_id = found.id;
                if (String(found.org_id) !== String(a.org_id)) {
                    await sq.query(`UPDATE cliq."scopes" SET "org_id" = :org_id, "scope_type" = 'org' WHERE "id" = :scope_id`,
                        { replacements: { org_id: a.org_id, scope_id } });
                    linked++;
                }
            }
            await sq.query(
                `INSERT INTO cliq."scope_members" ("scope_id", "user_id") VALUES (:scope_id, :user_id) ON CONFLICT DO NOTHING`,
                { replacements: { scope_id, user_id: a.user_id } },
            );
            await sq.query(`UPDATE cliq."orgs" SET "default_scope_id" = :scope_id WHERE "id" = :org_id AND "default_scope_id" IS NULL`,
                { replacements: { scope_id, org_id: a.org_id } });
        }

        await sq.query(
            `INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW()) ON CONFLICT ("key") DO NOTHING`,
            { replacements: { key: ACCOUNT_SCOPES_MIGRATION_KEY, value: new Date().toISOString() } },
        );
        _mig_log.info('account_scopes_migrated', { accounts: accounts.length, created, linked, other_owner });
    } catch (err) {
        _mig_log.error('account_scopes_migration_failed', { error: (err as Error)?.message ?? String(err) });
    }
}

/** `cliq.settings` key marking the one-time removal of rules on retired events as done. */
export const REMOVED_EVENT_RULES_MIGRATION_KEY = 'migrate.removed_event_rules_2026_10';

/** Events retired in Oct 2026 — frozen as written (PLAN-notifications-v2 B4.5). */
const REMOVED_EVENTS_2026_10 = ['phase.input_required', 'hug.review_requested'] as const;

/**
 * One time (Oct 2026): delete every notification rule on an event that is no longer an event —
 * `phase.input_required` and `hug.review_requested`. A phase that needs a person now posts its own Hug to
 * its channels; those rules can never match again. Built-in defaults and rules people added alike.
 * Safe to repeat; the key is recorded once everything succeeded.
 */
export async function migrate_removed_event_rules(sq: Sequelize): Promise<void> {
    try {
        const [tables] = await sq.query(`SELECT to_regclass('cliq.settings') AS s, to_regclass('cliq.notification_rules') AS r`, { type: QueryTypes.SELECT }) as Array<{ s: string | null; r: string | null }>;
        if (!tables?.s || !tables?.r) {
            _mig_log.info('removed_event_rules_deferred', { reason: 'cliq.settings or cliq.notification_rules not created yet' });
            return;
        }
        const done = await sq.query(`SELECT 1 FROM cliq."settings" WHERE "key" = :key`,
            { replacements: { key: REMOVED_EVENT_RULES_MIGRATION_KEY }, type: QueryTypes.SELECT });
        if (done.length > 0) return;

        const deleted = await sq.query(
            `DELETE FROM cliq."notification_rules" WHERE "event" IN (:events) RETURNING "id"`,
            { replacements: { events: [...REMOVED_EVENTS_2026_10] }, type: QueryTypes.SELECT },
        );

        await sq.query(
            `INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW()) ON CONFLICT ("key") DO NOTHING`,
            { replacements: { key: REMOVED_EVENT_RULES_MIGRATION_KEY, value: new Date().toISOString() } },
        );
        _mig_log.info('removed_event_rules_migrated', { deleted: deleted.length });
    } catch (err) {
        _mig_log.error('removed_event_rules_migration_failed', { error: (err as Error)?.message ?? String(err) });
    }
}

/** `cliq.settings` key marking the one-time revoke of the admin account's test tokens as done. */
export const ADMIN_TEST_TOKENS_MIGRATION_KEY = 'migrate.revoke_admin_test_tokens_2026_10';

/** Exactly which tokens — frozen as written (PLAN-tokens-sessions step 1). */
const ADMIN_TEST_TOKENS_2026_10 = {
    username: 'admin',
    /** Made by Core's test suite running against prod: `test…`, and `jira-` + a 13-digit timestamp. */
    name_pattern: '^(test|jira-[0-9]{13}$)',
    created_from: '2026-08-15',
    created_before: '2026-09-12',
} as const;

/**
 * One time (Oct 2026): revoke the `admin` account's tokens left by Core's test suite having run against prod
 * (Aug 15 – Sep 11): active tokens named `test…` or `jira-<13-digit timestamp>`, made in that window. Sets
 * `revoked_at` only — nothing is deleted; the account's other tokens (its realm tokens, sessions) are left.
 * Safe to repeat; the key is recorded once it succeeded.
 */
export async function revoke_admin_test_tokens(sq: Sequelize): Promise<void> {
    try {
        const [tables] = await sq.query(`SELECT to_regclass('cliq.settings') AS s, to_regclass('cliq.tokens') AS t`, { type: QueryTypes.SELECT }) as Array<{ s: string | null; t: string | null }>;
        if (!tables?.s || !tables?.t) {
            _mig_log.info('admin_test_tokens_deferred', { reason: 'cliq.settings or cliq.tokens not created yet' });
            return;
        }
        const done = await sq.query(`SELECT 1 FROM cliq."settings" WHERE "key" = :key`,
            { replacements: { key: ADMIN_TEST_TOKENS_MIGRATION_KEY }, type: QueryTypes.SELECT });
        if (done.length > 0) return;

        const spec = ADMIN_TEST_TOKENS_2026_10;
        const revoked = await sq.query(
            `UPDATE cliq."tokens" tk SET "revoked_at" = NOW()
             FROM cliq."users" u
             WHERE u."id"::text = tk."user_id"::text AND u."username" = :username
               AND tk."revoked_at" IS NULL
               AND tk."name" ~ :pattern
               AND tk."created_at" >= CAST(:from AS date) AND tk."created_at" < CAST(:before AS date)
             RETURNING tk."id"`,
            { replacements: { username: spec.username, pattern: spec.name_pattern, from: spec.created_from, before: spec.created_before }, type: QueryTypes.SELECT },
        );

        await sq.query(
            `INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW()) ON CONFLICT ("key") DO NOTHING`,
            { replacements: { key: ADMIN_TEST_TOKENS_MIGRATION_KEY, value: new Date().toISOString() } },
        );
        _mig_log.info('admin_test_tokens_revoked', { revoked: revoked.length });
    } catch (err) {
        _mig_log.error('admin_test_tokens_migration_failed', { error: (err as Error)?.message ?? String(err) });
    }
}

/** `cliq.settings` key marking the one-time realm team-list versions as done. */
export const REALM_TEAM_LIST_VERSIONS_MIGRATION_KEY = 'migrate.realm_team_list_versions_2026_10';

/**
 * One time (Oct 2026, PLAN-realm-team-versions): the realm owns each team's version. Every entry on a realm's
 * team list gets `version` — the one it already has when that version exists, else the team's latest published
 * version. Entries whose team isn't in the catalog or has no version are removed (no daemon can install them).
 * Prod before: 15 realms, 48 entries — 41 versioned, 7 removed. Safe to repeat; the key is recorded on success.
 */
export async function migrate_realm_team_list_versions(sq: Sequelize): Promise<void> {
    try {
        const [tables] = await sq.query(`SELECT to_regclass('cliq.settings') AS s, to_regclass('cliq.realms') AS r, to_regclass('cliq.team_versions') AS v`, { type: QueryTypes.SELECT }) as Array<{ s: string | null; r: string | null; v: string | null }>;
        if (!tables?.s || !tables?.r || !tables?.v) {
            _mig_log.info('realm_team_list_versions_deferred', { reason: 'tables not created yet' });
            return;
        }
        const done = await sq.query(`SELECT 1 FROM cliq."settings" WHERE "key" = :key`,
            { replacements: { key: REALM_TEAM_LIST_VERSIONS_MIGRATION_KEY }, type: QueryTypes.SELECT });
        if (done.length > 0) return;

        const versions = await sq.query(
            `SELECT t."scope", t."name", v."version" FROM cliq."teams" t JOIN cliq."team_versions" v ON v."team_id" = t."id"`,
            { type: QueryTypes.SELECT },
        ) as Array<{ scope: string | null; name: string; version: string }>;
        const by_team = new Map<string, string[]>();
        for (const r of versions) {
            const key = `${r.scope ?? ''}/${r.name}`;
            by_team.set(key, [...(by_team.get(key) ?? []), r.version]);
        }

        const realms = await sq.query(
            `SELECT "id", "team_list" FROM cliq."realms" WHERE jsonb_array_length(COALESCE("team_list", '[]'::jsonb)) > 0`,
            { type: QueryTypes.SELECT },
        ) as Array<{ id: string; team_list: Array<{ scope: string; slug: string; version?: string }> }>;

        let realms_changed = 0;
        let versioned = 0;
        const removed: string[] = [];
        for (const realm of realms) {
            const next: Array<{ scope: string; slug: string; version: string }> = [];
            for (const e of realm.team_list ?? []) {
                const have = by_team.get(`${e.scope}/${e.slug}`) ?? [];
                if (have.length === 0) { removed.push(`${realm.id}:@${e.scope}/${e.slug}`); continue; }
                const version = e.version && have.includes(e.version)
                    ? e.version
                    : SemVer.sort_desc(have.map((v) => ({ version: v })))[0]!.version;
                if (version !== e.version) versioned++;
                next.push({ scope: e.scope, slug: e.slug, version });
            }
            if (JSON.stringify(next) === JSON.stringify(realm.team_list)) continue;
            await sq.query(`UPDATE cliq."realms" SET "team_list" = CAST(:list AS jsonb), "updated_at" = :now WHERE "id" = :id`,
                { replacements: { list: JSON.stringify(next), now: Date.now(), id: realm.id } });
            realms_changed++;
        }

        await sq.query(
            `INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW()) ON CONFLICT ("key") DO NOTHING`,
            { replacements: { key: REALM_TEAM_LIST_VERSIONS_MIGRATION_KEY, value: new Date().toISOString() } },
        );
        _mig_log.info('realm_team_list_versions_migrated', { realms: realms.length, realms_changed, versioned, removed: removed.length, removed_entries: removed });
    } catch (err) {
        _mig_log.error('realm_team_list_versions_migration_failed', { error: (err as Error)?.message ?? String(err) });
    }
}

/** `cliq.settings` key marking the one-time merge of per-org personal channels as done. */
export const PERSONAL_CHANNEL_PER_USER_MIGRATION_KEY = 'migrate.personal_channel_per_user_2026_10';

/**
 * One time (Oct 2026, PLAN-personal-channel): one personal channel per user, for the whole account. A user's
 * per-org copies are merged into the oldest: it loses its org; the others' destinations it lacks (same type +
 * config) move onto it; rules, subscriptions, review notifications and review policies that name a copy now name
 * it; the copies are deleted. Then the one-per-user unique index. Safe to repeat; the key is recorded on success.
 */
export async function migrate_personal_channel_per_user(sq: Sequelize): Promise<void> {
    try {
        const [tables] = await sq.query(`SELECT to_regclass('cliq.settings') AS s, to_regclass('cliq.notification_channels') AS c`, { type: QueryTypes.SELECT }) as Array<{ s: string | null; c: string | null }>;
        if (!tables?.s || !tables?.c) {
            _mig_log.info('personal_channel_per_user_deferred', { reason: 'tables not created yet' });
            return;
        }
        const done = await sq.query(`SELECT 1 FROM cliq."settings" WHERE "key" = :key`,
            { replacements: { key: PERSONAL_CHANNEL_PER_USER_MIGRATION_KEY }, type: QueryTypes.SELECT });
        if (done.length > 0) return;

        const rows = await sq.query(
            `SELECT "id", "user_id"::text AS "user_id", "org_id" FROM cliq."notification_channels"
             WHERE "user_id" IS NOT NULL ORDER BY "user_id", "created_at" ASC, "id" ASC`,
            { type: QueryTypes.SELECT },
        ) as Array<{ id: string; user_id: string; org_id: string | null }>;
        const by_user = new Map<string, string[]>();
        for (const r of rows) by_user.set(r.user_id, [...(by_user.get(r.user_id) ?? []), r.id]);

        let merged = 0;
        let moved_destinations = 0;
        await sq.transaction(async (t) => {
            for (const [, ids] of by_user) {
                const [keep, ...copies] = ids;
                for (const copy of copies) {
                    // Destinations the kept channel lacks move over; the rest go with the copy.
                    const [, moved] = await sq.query(
                        `UPDATE cliq."channel_destinations" d SET "channel_id" = :keep
                         WHERE d."channel_id" = :copy AND NOT EXISTS (
                             SELECT 1 FROM cliq."channel_destinations" k
                             WHERE k."channel_id" = :keep AND k."type" = d."type" AND k."config"::jsonb = d."config"::jsonb)`,
                        { replacements: { keep, copy }, transaction: t },
                    ) as [unknown, number];
                    moved_destinations += Number(moved ?? 0);
                    // Rules: repoint unless the kept channel already has the same rule, then drop the copy's.
                    await sq.query(
                        `UPDATE cliq."notification_rules" r SET "channel_id" = :keep
                         WHERE r."channel_id" = :copy AND NOT EXISTS (
                             SELECT 1 FROM cliq."notification_rules" k WHERE k."channel_id" = :keep
                               AND k."event" = r."event" AND k."realm_id" IS NOT DISTINCT FROM r."realm_id"
                               AND k."org_id" IS NOT DISTINCT FROM r."org_id" AND k."team_slug" IS NOT DISTINCT FROM r."team_slug")`,
                        { replacements: { keep, copy }, transaction: t },
                    );
                    await sq.query(`DELETE FROM cliq."notification_rules" WHERE "channel_id" = :copy`, { replacements: { copy }, transaction: t });
                    await sq.query(`UPDATE cliq."notification_subscriptions" SET "channel_id" = :keep WHERE "channel_id" = :copy`, { replacements: { keep, copy }, transaction: t });
                    await sq.query(`UPDATE cliq."review_notifications" SET "channel_id" = :keep WHERE "channel_id" = :copy`, { replacements: { keep, copy }, transaction: t });
                    await sq.query(
                        `UPDATE cliq."reviews" SET "policy" = REPLACE("policy"::text, :copy_q, :keep_q)::jsonb WHERE "policy"::text LIKE :copy_like`,
                        { replacements: { copy_q: `"${copy}"`, keep_q: `"${keep}"`, copy_like: `%"${copy}"%` }, transaction: t },
                    );
                    await sq.query(`DELETE FROM cliq."notification_channels" WHERE "id" = :copy`, { replacements: { copy }, transaction: t });
                    merged++;
                }
                await sq.query(`UPDATE cliq."notification_channels" SET "org_id" = NULL, "realm_id" = NULL WHERE "id" = :keep`, { replacements: { keep }, transaction: t });
            }
        });
        await sq.query(`CREATE UNIQUE INDEX IF NOT EXISTS "notification_channels_user_uidx" ON cliq."notification_channels" ("user_id") WHERE "user_id" IS NOT NULL`);

        await sq.query(
            `INSERT INTO cliq."settings" ("key", "value", "updated_at") VALUES (:key, :value, NOW()) ON CONFLICT ("key") DO NOTHING`,
            { replacements: { key: PERSONAL_CHANNEL_PER_USER_MIGRATION_KEY, value: new Date().toISOString() } },
        );
        _mig_log.info('personal_channel_per_user_migrated', { users: by_user.size, copies_merged: merged, destinations_moved: moved_destinations });
    } catch (err) {
        _mig_log.error('personal_channel_per_user_migration_failed', { error: (err as Error)?.message ?? String(err) });
    }
}
