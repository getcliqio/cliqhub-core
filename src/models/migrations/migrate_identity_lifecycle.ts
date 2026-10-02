/**
 * Idempotent schema upgrades for the identity lifecycle: user and org status
 * with soft delete, pending memberships, tracked invite links, system
 * (locked) notification channels and rules with recipients, password links,
 * forgot-password request log and the email delivery log; org-event inbox
 * rows get the org of their event.
 *
 * Runs at the end of {@link migrate_hub_schema}, after `sequelize.sync()`, on
 * every boot. On a fresh database `sync()` has already created the new tables
 * from their models; the statements here then only add what models cannot
 * express (checks, partial unique indexes, foreign keys) and backfill data.
 *
 * Soft-deleted rows keep their names: the unique indexes on `users.username`,
 * `users.email` and `orgs.slug` are full indexes and are never narrowed to
 * live rows.
 */

import { QueryTypes, type Sequelize } from 'sequelize';

/**
 * Applies every identity-lifecycle column, table, constraint and backfill.
 *
 * @param sequelize - The Hub connection (search_path `cliq,public`).
 */
export async function migrate_identity_lifecycle(sequelize: Sequelize): Promise<void> {
    const q = (sql: string) => sequelize.query(sql);

    // ── users ────────────────────────────────────────────────────────
    await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
    await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
    // Invited people have no username or password until they accept / set one.
    await q(`ALTER TABLE users ALTER COLUMN username DROP NOT NULL`);
    await q(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`);
    await add_check(sequelize, 'users', 'users_status_check', `status IN ('invited', 'active', 'suspended')`);
    // `suspended_at` and `status` describe the same thing; keep them consistent.
    await q(`UPDATE users SET status = 'suspended' WHERE status = 'active' AND suspended_at IS NOT NULL`);
    await q(`UPDATE users SET status = CASE WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END WHERE status = 'suspended' AND suspended_at IS NULL`);
    await q(`CREATE INDEX IF NOT EXISTS users_status_idx ON users (status)`);

    // ── orgs ─────────────────────────────────────────────────────────
    await q(`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
    await q(`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
    await q(`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS owner_id UUID`);
    await q(`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ`);
    await q(`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS notifications_seeded_at TIMESTAMPTZ`);
    await q(`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS notifications_seed_version INTEGER`);
    await add_check(sequelize, 'orgs', 'orgs_status_check', `status IN ('active', 'waiting_for_owner', 'deleted')`);
    await add_fk(sequelize, 'orgs', 'orgs_owner_id_fkey', 'owner_id', 'users', 'SET NULL');
    await q(`CREATE INDEX IF NOT EXISTS orgs_owner_id_idx ON orgs (owner_id)`);
    await q(`CREATE INDEX IF NOT EXISTS orgs_status_idx ON orgs (status)`);
    await q(`UPDATE orgs SET activated_at = created_at WHERE activated_at IS NULL AND status = 'active'`);
    // Owner: the member holding the owner role (an `admin` row of the `role` text column without a role id counts);
    // the user named like the org (account org) first, then the earliest user.
    await q(`
        UPDATE orgs o SET owner_id = (
            SELECT om.user_id
            FROM org_members om
            JOIN users u ON u.id = om.user_id
            LEFT JOIN org_roles r ON r.id = om.role_id
            WHERE om.org_id = o.id
              AND (r.slug = 'owner' OR (om.role_id IS NULL AND om.role IN ('owner', 'admin')))
            ORDER BY (lower(u.username) = lower(o.slug)) DESC, u.created_at ASC
            LIMIT 1
        )
        WHERE o.owner_id IS NULL
    `);

    // ── memberships ──────────────────────────────────────────────────
    await q(`ALTER TABLE org_members ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
    await q(`ALTER TABLE org_members ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
    await q(`ALTER TABLE org_members ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ`);
    await q(`ALTER TABLE org_members ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ`);
    await add_check(sequelize, 'org_members', 'org_members_status_check', `status IN ('pending', 'active')`);

    await q(`ALTER TABLE cliq."realm_members" ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
    await q(`ALTER TABLE cliq."realm_members" ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
    await add_check(sequelize, 'realm_members', 'realm_members_status_check', `status IN ('pending', 'active')`);

    // ── invites (org/owner and realm) ────────────────────────────────
    for (const table of ['account_invites', 'realm_invites']) {
        await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS token_enc TEXT`);
        await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS send_count INTEGER NOT NULL DEFAULT 1`);
        await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ`);
        await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS reminders_sent INTEGER NOT NULL DEFAULT 0`);
        await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ`);
        await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS decision TEXT`);
        await q(`UPDATE ${table} SET last_sent_at = created_at WHERE last_sent_at IS NULL`);
        await add_check(sequelize, table, `${table}_decision_check`, `decision IS NULL OR decision IN ('accept', 'decline')`);
        await add_check(sequelize, table, `${table}_status_check`, `status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')`);
        await q(`CREATE INDEX IF NOT EXISTS ${table}_pending_expires_idx ON ${table} (expires_at) WHERE status = 'pending'`);
    }
    // Org and owner invites never carry `operator` (a realm role).
    await q(`ALTER TABLE account_invites DROP CONSTRAINT IF EXISTS account_invites_role_check`);
    await add_check(sequelize, 'account_invites', 'account_invites_org_role_check', `role IN ('owner', 'admin', 'member')`);
    await add_check(sequelize, 'realm_invites', 'realm_invites_role_check', `role IN ('admin', 'operator', 'member')`);

    // ── system channels and rules ────────────────────────────────────
    for (const table of ['notification_channels', 'notification_rules']) {
        await q(`ALTER TABLE cliq."${table}" ADD COLUMN IF NOT EXISTS system_key TEXT`);
        await q(`ALTER TABLE cliq."${table}" ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE`);
        await q(`ALTER TABLE cliq."${table}" ADD COLUMN IF NOT EXISTS lock_reason TEXT`);
    }
    await q(`ALTER TABLE cliq."notification_rules" ADD COLUMN IF NOT EXISTS recipients JSONB`);
    await q(`
        CREATE UNIQUE INDEX IF NOT EXISTS notification_channels_org_system_key_uidx
        ON cliq."notification_channels" (org_id, system_key)
        WHERE system_key IS NOT NULL
    `);
    await q(`
        CREATE UNIQUE INDEX IF NOT EXISTS notification_rules_org_system_key_uidx
        ON cliq."notification_rules" (org_id, system_key, event, channel_id)
        WHERE system_key IS NOT NULL
    `);

    // ── password links (set-password for new users, reset) ───────────
    await q(`
        CREATE TABLE IF NOT EXISTS password_resets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL,
            purpose TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            token_enc TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            send_count INTEGER NOT NULL DEFAULT 1,
            last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            requested_by UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await add_check(sequelize, 'password_resets', 'password_resets_purpose_check', `purpose IN ('setup', 'reset')`);
    await add_fk(sequelize, 'password_resets', 'password_resets_user_id_fkey', 'user_id', 'users', 'CASCADE');
    await add_fk(sequelize, 'password_resets', 'password_resets_requested_by_fkey', 'requested_by', 'users', 'SET NULL');
    // One open link per user and purpose: asking again reuses it.
    await q(`
        CREATE UNIQUE INDEX IF NOT EXISTS password_resets_open_uidx
        ON password_resets (user_id, purpose)
        WHERE used_at IS NULL
    `);

    // Public "Forgot password" requests, counted for the per-email limit.
    await q(`
        CREATE TABLE IF NOT EXISTS password_reset_requests (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS password_reset_requests_email_idx ON password_reset_requests (email, created_at)`);

    // ── email delivery log ───────────────────────────────────────────
    await q(`
        CREATE TABLE IF NOT EXISTS email_deliveries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            subject_type TEXT NOT NULL,
            subject_id UUID NOT NULL,
            event TEXT NOT NULL,
            event_id TEXT,
            org_id UUID,
            channel_id TEXT,
            "to" TEXT NOT NULL,
            sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ok BOOLEAN NOT NULL,
            provider_message_id TEXT,
            error TEXT
        )
    `);
    await add_check(sequelize, 'email_deliveries', 'email_deliveries_subject_type_check', `subject_type IN ('invite', 'reset', 'user')`);
    await q(`CREATE INDEX IF NOT EXISTS email_deliveries_subject_idx ON email_deliveries (subject_type, subject_id, sent_at)`);

    await backfill_org_event_inbox_orgs(sequelize);
}

/** In-app events of the org lifecycle (invites, abandoned orgs, account events). */
const ORG_EVENT_INBOX_SQL = `(event LIKE 'invite.%' OR event IN ('org.abandoned', 'user.setup.sent', 'user.password_reset.sent', 'user.password.changed'))`;

/**
 * Gives org-event inbox rows written without an org (no realm) the org of
 * their event, so they show in that org's inbox: the org named in the stored
 * event data (`data.org.slug`, else `data.org.id`), or for account events the
 * account org (`data.user.username`). Rows it cannot place are left as they are.
 */
async function backfill_org_event_inbox_orgs(sequelize: Sequelize): Promise<void> {
    const rows = await sequelize.query<{ id: string; payload_json: string }>(
        `SELECT id, payload_json FROM in_app_notifications WHERE org_id IS NULL AND realm_id IS NULL AND ${ORG_EVENT_INBOX_SQL}`,
        { type: QueryTypes.SELECT },
    );
    for (const row of rows) {
        let data: { org?: { id?: unknown; slug?: unknown }; user?: { username?: unknown } } | undefined;
        try {
            data = (JSON.parse(row.payload_json) as { data?: typeof data }).data;
        } catch {
            continue;
        }
        const slug = typeof data?.org?.slug === 'string' ? data.org.slug : typeof data?.user?.username === 'string' ? data.user.username : null;
        const id = typeof data?.org?.id === 'string' ? data.org.id : null;
        if (!slug && !id) continue;
        const [org] = await sequelize.query<{ id: string }>(
            slug ? 'SELECT id FROM orgs WHERE slug = :slug' : 'SELECT id FROM orgs WHERE id::text = :id',
            { type: QueryTypes.SELECT, replacements: slug ? { slug } : { id } },
        );
        if (!org) continue;
        await sequelize.query('UPDATE in_app_notifications SET org_id = :org_id WHERE id = :id AND org_id IS NULL', { replacements: { org_id: org.id, id: row.id } });
    }
}

/**
 * Adds a CHECK constraint once. It is added `NOT VALID` so rows written
 * before the constraint existed never block a boot; new writes are checked.
 */
async function add_check(sequelize: Sequelize, table: string, name: string, expr: string): Promise<void> {
    await sequelize.query(`
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
                ALTER TABLE cliq."${table}" ADD CONSTRAINT "${name}" CHECK (${expr}) NOT VALID;
            END IF;
        END $$
    `);
}

/** Adds a foreign key to `cliq.<ref_table>(id)` once. */
async function add_fk(
    sequelize: Sequelize, table: string, name: string, column: string,
    ref_table: string, on_delete: 'CASCADE' | 'SET NULL',
): Promise<void> {
    await sequelize.query(`
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
                ALTER TABLE cliq."${table}" ADD CONSTRAINT "${name}"
                    FOREIGN KEY ("${column}") REFERENCES cliq."${ref_table}"(id) ON DELETE ${on_delete};
            END IF;
        END $$
    `);
}
