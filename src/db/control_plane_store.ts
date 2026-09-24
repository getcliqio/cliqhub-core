/**
 * Control-plane persistence (`cliq` schema) via `@getcliqio/cliq-store`.
 *
 * Hub registry/identity tables live in Postgres `public` (Hub Sequelize).
 * Control-plane tables (daemons, workspaces, runs, daemon_config, …) live in
 * schema `cliq` and are owned by the shared store package used by the daemon
 * (sqlite) and this API (postgres).
 *
 * Important: always open the store through `connect_store` from the package so
 * models and the Sequelize constructor share one module instance. Creating a
 * Hub-local `new Sequelize()` against store models fails associations when
 * two copies of `sequelize` are installed (monorepo file: link).
 *
 * Clean break: schema `cliq` is migrated + seeded on every process boot
 * (idempotent). No dual-DB runtime — one DATABASE_URL.
 *
 * Ops — one-time data move (not runtime compatibility):
 *   If an existing Core API database already has schema `cliq`, restore it
 *   into this Hub database once:
 *     pg_dump --schema=cliq "$OLD_CORE_DATABASE_URL" | psql "$DATABASE_URL"
 *   Then boot Hub (migrate/seed are no-ops for existing rows).
 */

import {
    connect_store,
    migrate_store,
    type StoreConnection,
} from '@getcliqio/cliq-store';

import { run_core_api_schema_migrations } from './control_plane_schema_migrations.js';
import { init_core_api_models, reset_core_api_models } from '../models/index.js';
import { get_logger } from '../lib/log.js';
import { seed_control_plane } from './control_plane_seed.js';
import { should_use_ssl } from './sequelize.js';
import { init_model_pricing_service, reset_model_pricing_service } from '../services/model_pricing.service.js';

const log = get_logger('store');

let _connection: StoreConnection | null = null;

/**
 * Open (or return) the control-plane store, create schema `cliq` if needed,
 * sync store models, init Hub-only core_api models, run BFF SQL migrations,
 * and seed org defaults. Idempotent — safe on every boot.
 *
 * Retries connection up to 5 times with exponential backoff to handle
 * cold-start races on Railway where Postgres may not be ready immediately.
 */
export async function init_control_plane_store(
    database_url: string,
): Promise<StoreConnection> {
    if (_connection) return _connection;

    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 2000;
    let last_error: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const connection = await connect_store({
                dialect: 'postgres',
                db_url: database_url,
                ssl: should_use_ssl(database_url),
            });
            await migrate_store(connection.sequelize);
            init_core_api_models(connection.sequelize);
            await run_core_api_schema_migrations(connection.sequelize);
            await seed_control_plane();

            _connection = connection;
            init_model_pricing_service(connection.sequelize);
            log.info('control_plane_store_ready', { schema: 'cliq' });
            return _connection;
        } catch (err) {
            last_error = err;
            if (attempt < MAX_RETRIES) {
                const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
                log.warn('db_connect_retry', {
                    attempt,
                    max_retries: MAX_RETRIES,
                    delay_ms: delay,
                    error: err instanceof Error ? err.message : String(err),
                });
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }

    throw last_error;
}

/** Active control-plane connection; throws if `init_control_plane_store` was not called. */
export function get_control_plane_store(): StoreConnection {
    if (!_connection) {
        throw new Error(
            'Control-plane store not initialized — call init_control_plane_store first',
        );
    }
    return _connection;
}

/** Close the control-plane Sequelize connection (shutdown / tests). */
export async function close_control_plane_store(): Promise<void> {
    if (!_connection) return;
    await _connection.close();
    _connection = null;
    reset_core_api_models();
    reset_model_pricing_service();
}
