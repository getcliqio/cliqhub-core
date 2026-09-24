import { Sequelize } from 'sequelize';

import {
    close_control_plane_store,
    init_control_plane_store,
} from '../../../src/db/control_plane_store.js';
import { migrate_hub_schema } from '../../../src/db/hub_schema_migrations.js';
import { init_models } from '../../../src/db/models/index.js';
import {
    close_sequelize,
    init_sequelize,
} from '../../../src/db/sequelize.js';

/** Local-only default. Never fall back to a shared/prod DATABASE_URL from .env. */
export const database_url =
    process.env.CLIQHUB_TEST_DATABASE_URL
    ?? 'postgresql://cliqhub:cliqhub@localhost:5432/cliqhub';

function assert_test_database_url(url: string): void {
    const lower = url.toLowerCase();
    const blocked = [
        'rlwy.net',
        'railway.internal',
        'railway.app',
        'amazonaws.com',
        'neon.tech',
        'supabase.co',
        'cliqhub.io',
    ];
    for (const host of blocked) {
        if (!lower.includes(host)) continue;
        throw new Error(
            `Refusing to run destructive migrated_platform tests against remote DB (${host}). `
            + 'Set CLIQHUB_TEST_DATABASE_URL to a local Postgres URL.',
        );
    }
    if (lower.includes('localhost') || lower.includes('127.0.0.1')) return;
    if (process.env.CLIQHUB_TEST_ALLOW_REMOTE_DB === '1') return;
    throw new Error(
        'Refusing migrated_platform tests against a non-local DATABASE_URL. '
        + 'Use localhost/127.0.0.1 or set CLIQHUB_TEST_ALLOW_REMOTE_DB=1 deliberately.',
    );
}

assert_test_database_url(database_url);

export async function postgres_reachable(): Promise<boolean> {
    const probe = new Sequelize(database_url, {
        dialect: 'postgres',
        logging: false,
    });

    try {
        await probe.authenticate();
        await probe.close();
        return true;
    } catch {
        try {
            await probe.close();
        } catch {
            // The failed connection may already be closed.
        }
        return false;
    }
}

export async function open_test_control_plane_store(): Promise<void> {
    assert_test_database_url(database_url);
    const sequelize = init_sequelize(database_url);
    init_models(sequelize);
    await sequelize.sync();
    await migrate_hub_schema(sequelize);
    // Shared local DB may already have BFF e2e fixtures on hub_legacy_uuid(1..3)
    // (alice/bob/carol) and/or orphan migrated-platform-* rows with other ids.
    // Normalize: free the usernames/emails, then upsert the fixed ids.
    await sequelize.query(`
        DELETE FROM users
        WHERE (
            username IN (
                'migrated-platform-user',
                'migrated-platform-user-2',
                'migrated-platform-user-3'
            )
            OR email IN (
                'platform@test.local',
                'platform2@test.local',
                'platform3@test.local'
            )
        )
        AND id NOT IN (
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000002',
            '00000000-0000-4000-8000-000000000003'
        )
    `);
    await sequelize.query(`
        INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
        VALUES
            ('00000000-0000-4000-8000-000000000001', 'migrated-platform-user', 'Migrated Platform User', 'platform@test.local', 'x', 'user', NOW()),
            ('00000000-0000-4000-8000-000000000002', 'migrated-platform-user-2', 'Migrated Platform User 2', 'platform2@test.local', 'x', 'user', NOW()),
            ('00000000-0000-4000-8000-000000000003', 'migrated-platform-user-3', 'Migrated Platform User 3', 'platform3@test.local', 'x', 'user', NOW())
        ON CONFLICT (id) DO UPDATE SET
            username = EXCLUDED.username,
            display_name = EXCLUDED.display_name,
            email = EXCLUDED.email,
            password_hash = EXCLUDED.password_hash,
            role = EXCLUDED.role
    `);
    await init_control_plane_store(database_url);
}

export async function close_test_control_plane_store(): Promise<void> {
    await close_control_plane_store();
    await close_sequelize();
}
